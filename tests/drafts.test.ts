import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config/index.js';
import type { DraftContentInput } from '../src/drafts/types.js';
import type { PushAttempt } from '../src/git/types.js';
import { getDailyActivity } from '../src/services/activity.js';
import { DailyDraftService, DraftError } from '../src/services/daily-log.js';
import { JsonDraftStore } from '../src/storage/draft-store.js';
import { JsonEventStore } from '../src/storage/json-store.js';

const directories: string[] = [];

async function fixture(): Promise<{
  dataDirectory: string;
  service: DailyDraftService;
  event: PushAttempt;
  content: DraftContentInput;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-devlog-drafts-'));
  directories.push(dataDirectory);
  await saveConfig({ version: 1, timezone: 'Asia/Seoul', repositories: [] }, dataDirectory);
  const event: PushAttempt = {
    id: '1'.repeat(64),
    repositoryId: '2'.repeat(64),
    repositoryName: 'example',
    repositoryPath: join(dataDirectory, 'missing-repository'),
    remoteName: 'origin',
    remoteUrl: 'https://example.invalid/repository.git',
    localRef: 'refs/heads/main',
    localSha: '3'.repeat(40),
    remoteRef: 'refs/heads/main',
    remoteSha: '0'.repeat(40),
    recordedAt: '2026-10-22T15:30:00.000Z',
    commits: [{ sha: '3'.repeat(40), subject: 'Implement draft storage', authorName: 'Test User' }],
    commitsTruncated: false,
  };
  await new JsonEventStore(dataDirectory).append([event]);
  const activity = await getDailyActivity('2026-10-23', dataDirectory);
  const content: DraftContentInput = {
    summary: 'Implemented versioned daily draft storage.',
    workItems: [{
      repositoryId: event.repositoryId,
      title: 'Draft storage',
      details: 'Added local persistence.',
      sourceEventIds: [event.id],
    }],
    nextActions: ['Add publication adapters'],
    sourceEventIds: [event.id],
    sourceFingerprint: activity.sourceFingerprint,
  };
  const service = new DailyDraftService(
    dataDirectory,
    undefined,
    () => new Date('2026-10-23T03:00:00.000Z'),
    () => '11111111-1111-4111-8111-111111111111',
  );
  return { dataDirectory, service, event, content };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('daily draft service', () => {
  it('saves, reads, lists, and idempotently handles the same date and content', async () => {
    const { service, content } = await fixture();
    const input = { workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content };
    const first = await service.save(input);
    const retry = await service.save(input);

    expect(first.draft).toMatchObject({ version: 1, status: 'PENDING', approvedAt: null });
    expect(first.draft.workItems[0]?.verificationStatus).toBe('UNCONFIRMED');
    expect(retry.draft.draftId).toBe(first.draft.draftId);
    expect((await service.get(first.draft.draftId)).revisions).toHaveLength(1);
    expect(await service.list({ workDate: '2026-10-23', status: 'PENDING' })).toHaveLength(1);
    await expect(service.save({ ...input, summary: 'Different' })).rejects.toMatchObject({ code: 'DRAFT_ALREADY_EXISTS' });
  });

  it('increments versions, preserves history, detects conflicts, and supports reject/reopen', async () => {
    const { service, content } = await fixture();
    const saved = await service.save({ workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content });
    const rejected = await service.update({
      draftId: saved.draft.draftId,
      expectedVersion: 1,
      status: 'REJECTED',
      ...content,
      summary: 'Needs changes',
    });
    expect(rejected.draft).toMatchObject({ version: 2, status: 'REJECTED' });
    expect(rejected.revisions).toHaveLength(2);

    await expect(service.update({
      draftId: saved.draft.draftId,
      expectedVersion: 1,
      status: 'PENDING',
      ...content,
    })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(service.approve(saved.draft.draftId, 2, 'MCP_ELICITATION')).rejects.toMatchObject({ code: 'DRAFT_REJECTED' });

    const reopened = await service.update({
      draftId: saved.draft.draftId,
      expectedVersion: 2,
      status: 'PENDING',
      ...content,
    });
    expect(reopened.draft).toMatchObject({ version: 3, status: 'PENDING' });
    expect(reopened.revisions.map(({ version }) => version)).toEqual([1, 2, 3]);
  });

  it('approves one exact version, stays immutable, and handles duplicate approval', async () => {
    const { service, content } = await fixture();
    const saved = await service.save({ workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content });
    await expect(service.approve(saved.draft.draftId, 2, 'MCP_ELICITATION')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const approved = await service.approve(saved.draft.draftId, 1, 'MCP_ELICITATION');
    const duplicate = await service.approve(saved.draft.draftId, 1, 'MCP_ELICITATION');

    expect(approved.draft).toMatchObject({
      version: 1,
      status: 'APPROVED',
      approvedVersion: 1,
      approvalMethod: 'MCP_ELICITATION',
    });
    expect(duplicate.draft.approvedAt).toBe(approved.draft.approvedAt);
    await expect(service.update({
      draftId: saved.draft.draftId,
      expectedVersion: 1,
      status: 'PENDING',
      ...content,
    })).rejects.toMatchObject({ code: 'DRAFT_APPROVED' });
  });

  it('keeps an existing draft editable in its original timezone after configuration changes', async () => {
    const { dataDirectory, service, content } = await fixture();
    const saved = await service.save({ workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content });
    await saveConfig({ version: 1, timezone: 'America/Los_Angeles', repositories: [] }, dataDirectory);
    const updated = await service.update({
      draftId: saved.draft.draftId,
      expectedVersion: 1,
      status: 'PENDING',
      ...content,
      summary: 'Edited after the configured timezone changed',
    });
    expect(updated.draft).toMatchObject({ version: 2, timezone: 'Asia/Seoul' });
  });

  it('warns but permits approval if newer source activity appeared', async () => {
    const { dataDirectory, service, event, content } = await fixture();
    const saved = await service.save({ workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content });
    await new JsonEventStore(dataDirectory).append([{ ...event, id: '4'.repeat(64), localSha: '4'.repeat(40) }]);
    const approved = await service.approve(saved.draft.draftId, 1, 'EXPLICIT_CONFIRMATION_FALLBACK');
    expect(approved.draft.approvalWarnings).toEqual(['SOURCE_CHANGED_AFTER_DRAFT']);
  });

  it('rejects empty, stale, unknown, and cross-repository sources', async () => {
    const emptyDirectory = await mkdtemp(join(tmpdir(), 'local-devlog-empty-draft-'));
    directories.push(emptyDirectory);
    await saveConfig({ version: 1, timezone: 'Asia/Seoul', repositories: [] }, emptyDirectory);
    const emptyService = new DailyDraftService(emptyDirectory);
    await expect(emptyService.save({
      workDate: '2026-10-23', timezone: 'Asia/Seoul',
      summary: 'Invented', workItems: [{ repositoryId: '2'.repeat(64), title: 'No source', details: '', sourceEventIds: ['1'.repeat(64)] }],
      nextActions: [], sourceEventIds: ['1'.repeat(64)], sourceFingerprint: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'NO_SOURCE_ACTIVITY' });

    const { service, content } = await fixture();
    await expect(service.save({
      workDate: '2026-02-30', timezone: 'Asia/Seoul', ...content,
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(service.save({
      workDate: '2026-10-23', timezone: 'America/Los_Angeles', ...content,
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    await expect(service.save({
      workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content, sourceFingerprint: '0'.repeat(64),
    })).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await expect(service.save({
      workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content,
      workItems: [{ ...content.workItems[0]!, repositoryId: '9'.repeat(64) }],
    })).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('preserves the old file when an update replacement fails', async () => {
    const { dataDirectory, service, content } = await fixture();
    const saved = await service.save({ workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content });
    const failingStore = new JsonDraftStore(dataDirectory, {
      rename: async () => { throw new Error('simulated draft rename failure'); },
    });
    const failingService = new DailyDraftService(dataDirectory, failingStore);
    await expect(failingService.update({
      draftId: saved.draft.draftId,
      expectedVersion: 1,
      status: 'PENDING',
      ...content,
      summary: 'Should not persist',
    })).rejects.toThrow('simulated draft rename failure');
    expect((await service.get(saved.draft.draftId)).draft.summary).toBe(content.summary);
    expect(JSON.parse(await readFile(join(dataDirectory, 'drafts.json'), 'utf8'))).toBeDefined();
  });

  it('serializes concurrent edits so one stale writer loses', async () => {
    const { service, content } = await fixture();
    const saved = await service.save({ workDate: '2026-10-23', timezone: 'Asia/Seoul', ...content });
    const updates = await Promise.allSettled(['A', 'B'].map((summary) => service.update({
      draftId: saved.draft.draftId,
      expectedVersion: 1,
      status: 'PENDING',
      ...content,
      summary,
    })));
    expect(updates.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = updates.find(({ status }) => status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(DraftError);
  });
});
