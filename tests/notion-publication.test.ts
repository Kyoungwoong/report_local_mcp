import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NotionAdapterError,
  type CreateTaskInput,
  type CreateWorkLogInput,
  type NotionConnectionValidation,
  type NotionPort,
} from '../src/adapters/notion.js';
import { saveConfig } from '../src/config/index.js';
import type { PushAttempt } from '../src/git/types.js';
import { getDailyActivity } from '../src/services/activity.js';
import { DailyDraftService } from '../src/services/daily-log.js';
import { NotionPublicationService } from '../src/services/publisher.js';
import { JsonDraftStore } from '../src/storage/draft-store.js';
import { JsonEventStore } from '../src/storage/json-store.js';
import { JsonPublicationStore } from '../src/storage/publication-store.js';

const directories: string[] = [];

const validConnection: NotionConnectionValidation = {
  authenticated: true,
  botName: 'report-mcp',
  apiVersion: '2026-03-11',
  valid: true,
  tasks: {
    label: 'Tasks', databaseId: 'tasks-db', dataSourceId: 'tasks-ds', title: 'Tasks',
    properties: {}, mismatches: [], warnings: [], valid: true,
  },
  workLogs: {
    label: 'Work Logs', databaseId: 'logs-db', dataSourceId: 'logs-ds', title: 'Work Logs',
    properties: {}, mismatches: [], warnings: [], valid: true,
  },
};

class FakeNotion implements NotionPort {
  readonly tasks = new Map<string, string>();
  readonly workLogs = new Map<string, string>();
  readonly createdTasks: string[] = [];
  readonly createdWorkLogs: string[] = [];
  readonly createdWorkLogInputs: CreateWorkLogInput[] = [];
  failTask?: NotionAdapterError;
  failTaskOnce = false;

  async validateConnection(): Promise<NotionConnectionValidation> {
    return validConnection;
  }

  async findTaskByLocalId(localId: string): Promise<string | undefined> {
    return this.tasks.get(localId);
  }

  async createTask(input: CreateTaskInput): Promise<string> {
    if (this.failTask && (!this.failTaskOnce || this.createdTasks.length === 0)) {
      if (this.failTaskOnce) this.createdTasks.push('failed-attempt');
      throw this.failTask;
    }
    this.createdTasks.push(input.localId);
    const id = `task-${this.tasks.size + 1}`;
    this.tasks.set(input.localId, id);
    return id;
  }

  async findWorkLogByLocalId(localId: string): Promise<string | undefined> {
    return this.workLogs.get(localId);
  }

  async findWorkLogsByDate(): Promise<Array<{ id: string; localId?: string }>> {
    return [...this.workLogs.entries()].map(([localId, id]) => ({ id, localId }));
  }

  async createWorkLog(input: CreateWorkLogInput): Promise<string> {
    this.createdWorkLogs.push(input.localId);
    this.createdWorkLogInputs.push(input);
    const id = `work-${this.workLogs.size + 1}`;
    this.workLogs.set(input.localId, id);
    return id;
  }
}

async function draftFixture(approve = true): Promise<{
  dataDirectory: string;
  draftId: string;
  version: number;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-devlog-notion-'));
  directories.push(dataDirectory);
  await saveConfig({ version: 1, timezone: 'Asia/Seoul', repositories: [] }, dataDirectory);
  const event: PushAttempt = {
    id: '1'.repeat(64),
    repositoryId: '2'.repeat(64),
    repositoryName: 'notion-example',
    repositoryPath: join(dataDirectory, 'missing'),
    remoteName: 'origin',
    remoteUrl: 'https://example.invalid/notion-example.git',
    localRef: 'refs/heads/main',
    localSha: '3'.repeat(40),
    remoteRef: 'refs/heads/main',
    remoteSha: '0'.repeat(40),
    recordedAt: '2026-10-23T15:30:00.000Z',
    commits: [{ sha: '3'.repeat(40), subject: 'Notion publication', authorName: 'Test User' }],
    commitsTruncated: false,
  };
  const secondEvent: PushAttempt = {
    ...event,
    id: '4'.repeat(64),
    repositoryId: '5'.repeat(64),
    repositoryName: 'second-repository',
    repositoryPath: join(dataDirectory, 'second-repository'),
    remoteUrl: 'https://example.invalid/second-repository.git',
    localSha: '6'.repeat(40),
    commits: [{ sha: '6'.repeat(40), subject: 'Second repository work', authorName: 'Test User' }],
  };
  await new JsonEventStore(dataDirectory).append([event, secondEvent]);
  const activity = await getDailyActivity('2026-10-24', dataDirectory);
  const drafts = new DailyDraftService(
    dataDirectory,
    undefined,
    () => new Date('2026-10-24T02:00:00.000Z'),
    () => '11111111-1111-4111-8111-111111111111',
  );
  const saved = await drafts.save({
    workDate: '2026-10-24',
    timezone: 'Asia/Seoul',
    summary: 'Implemented Notion publication.',
    workItems: [{
      repositoryId: event.repositoryId,
      title: 'Notion adapter',
      details: 'Added idempotent publication and retry handling.',
      sourceEventIds: [event.id],
    }, {
      repositoryId: event.repositoryId,
      title: 'Notion tests',
      details: 'Covered the daily publication behavior.',
      sourceEventIds: [event.id],
    }, {
      repositoryId: secondEvent.repositoryId,
      title: 'Calendar coordination',
      details: 'Kept target state independent.',
      sourceEventIds: [secondEvent.id],
    }],
    nextActions: ['Add Calendar adapter', 'Review release notes'],
    sourceEventIds: [event.id, secondEvent.id],
    sourceFingerprint: activity.sourceFingerprint,
  });
  if (approve) await drafts.approve(saved.draft.draftId, 1, 'MCP_ELICITATION');
  return { dataDirectory, draftId: saved.draft.draftId, version: 1 };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Notion publication service', () => {
  it('rejects unapproved drafts, wrong versions, invalid selections, and missing publication authorization', async () => {
    const pending = await draftFixture(false);
    const pendingService = new NotionPublicationService(pending.dataDirectory, new FakeNotion());
    await expect(pendingService.preview({
      draftId: pending.draftId, version: 1, selectedNextActionIndexes: [],
    })).rejects.toMatchObject({ code: 'DRAFT_NOT_APPROVED' });

    const approved = await draftFixture();
    const service = new NotionPublicationService(approved.dataDirectory, new FakeNotion());
    await expect(service.preview({
      draftId: approved.draftId, version: 2, selectedNextActionIndexes: [],
    })).rejects.toMatchObject({ code: 'APPROVED_VERSION_MISMATCH' });
    await expect(service.preview({
      draftId: approved.draftId, version: 1, selectedNextActionIndexes: [9],
    })).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    const preview = await service.preview({ draftId: approved.draftId, version: 1, selectedNextActionIndexes: [0] });
    await expect(service.publish({
      draftId: approved.draftId,
      version: 1,
      selectedNextActionIndexes: [0],
      previewFingerprint: preview.previewFingerprint,
      publicationAuthorized: false,
    })).rejects.toMatchObject({ code: 'PUBLICATION_NOT_AUTHORIZED' });
  });

  it('publishes selected actions once and skips duplicate publication', async () => {
    const fixture = await draftFixture();
    const notion = new FakeNotion();
    const service = new NotionPublicationService(fixture.dataDirectory, notion);
    const input = { draftId: fixture.draftId, version: 1, selectedNextActionIndexes: [1] };
    const preview = await service.preview(input);
    expect(preview.workLogs).toHaveLength(1);
    expect(preview.workLogs[0]).toMatchObject({
      title: '개발 일지 | 2026-10-24',
      repositories: [
        { name: 'notion-example', workItems: [{ title: 'Notion adapter' }, { title: 'Notion tests' }] },
        { name: 'second-repository', workItems: [{ title: 'Calendar coordination' }] },
      ],
    });
    expect(preview.workLogs[0]).not.toHaveProperty('repositoryUrl');
    expect(preview.tasks.map(({ title }) => title)).toEqual(['Review release notes']);

    const first = await service.publish({ ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true });
    const second = await service.publish({ ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true });
    expect(first.status).toBe('SYNCED');
    expect(second).toMatchObject({ status: 'SYNCED', skipped: 2 });
    expect(notion.createdWorkLogs).toHaveLength(1);
    expect(notion.createdTasks).toHaveLength(1);
  });

  it('adopts one legacy Work Log without changing it and rejects conflicting daily claims', async () => {
    const fixture = await draftFixture();
    const legacyStore = new JsonPublicationStore(fixture.dataDirectory);
    const legacyLocalId = `${fixture.draftId}:v1:work:0`;
    await legacyStore.initialize({
      draftId: fixture.draftId,
      draftVersion: 1,
      workDate: '2026-10-24',
      timezone: 'Asia/Seoul',
      dailyKey: 'legacy',
      selectedNextActionIndexes: [],
      previewFingerprint: 'e'.repeat(64),
      items: [{ localId: legacyLocalId, kind: 'WORK_LOG', sourceIndex: 0 }],
      timestamp: '2026-10-24T02:00:00.000Z',
    });
    await legacyStore.markItem({
      draftId: fixture.draftId, draftVersion: 1, localId: legacyLocalId,
      status: 'SYNCED', externalId: 'legacy-page', timestamp: '2026-10-24T02:01:00.000Z',
    });
    const notion = new FakeNotion();
    const service = new NotionPublicationService(fixture.dataDirectory, notion);
    const input = { draftId: fixture.draftId, version: 1, selectedNextActionIndexes: [] };
    const preview = await service.preview(input);
    expect(preview).toMatchObject({ workLogDisposition: 'SKIP_EXISTING', existingWorkLog: { externalId: 'legacy-page' } });
    await expect(service.publish({
      ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true,
    })).resolves.toMatchObject({ status: 'SYNCED', skipped: 1 });
    expect(notion.createdWorkLogs).toHaveLength(0);
    const adopted = await legacyStore.get(fixture.draftId, 1);
    expect(adopted?.items.filter(({ kind }) => kind === 'WORK_LOG')).toEqual([
      expect.objectContaining({ localId: 'local-devlog:daily:2026-10-24:Asia%2FSeoul:work-log', externalId: 'legacy-page' }),
    ]);

    await legacyStore.initialize({
      draftId: '22222222-2222-4222-8222-222222222222', draftVersion: 1,
      workDate: '2026-10-24', timezone: 'Asia/Seoul', dailyKey: 'conflict',
      selectedNextActionIndexes: [], previewFingerprint: 'f'.repeat(64),
      items: [{ localId: 'other-work', kind: 'WORK_LOG', sourceIndex: 0 }],
      timestamp: '2026-10-24T03:00:00.000Z',
    });
    await legacyStore.markItem({
      draftId: '22222222-2222-4222-8222-222222222222', draftVersion: 1,
      localId: 'other-work', status: 'SYNCED', externalId: 'other-page', timestamp: '2026-10-24T03:01:00.000Z',
    });
    await expect(service.preview(input)).rejects.toMatchObject({ code: 'DAILY_PUBLICATION_CONFLICT' });
    await expect(service.getStatus(fixture.draftId, 1)).resolves.toMatchObject({ status: 'CONFLICT' });
  });

  it('allows the same workDate in another timezone and warns after new approved-day activity', async () => {
    const fixture = await draftFixture();
    const store = new JsonPublicationStore(fixture.dataDirectory);
    await store.initialize({
      draftId: '33333333-3333-4333-8333-333333333333', draftVersion: 1,
      workDate: '2026-10-24', timezone: 'America/Los_Angeles', dailyKey: 'other-zone',
      selectedNextActionIndexes: [], previewFingerprint: 'a'.repeat(64),
      items: [{ localId: 'other-zone-work', kind: 'WORK_LOG', sourceIndex: 0 }],
      timestamp: '2026-10-24T03:00:00.000Z',
    });
    await store.markItem({
      draftId: '33333333-3333-4333-8333-333333333333', draftVersion: 1,
      localId: 'other-zone-work', status: 'SYNCED', externalId: 'other-zone-page', timestamp: '2026-10-24T03:01:00.000Z',
    });
    const service = new NotionPublicationService(fixture.dataDirectory, new FakeNotion());
    await expect(service.preview({ draftId: fixture.draftId, version: 1, selectedNextActionIndexes: [] }))
      .resolves.toMatchObject({ sourceChangedAfterApproval: false });

    const existing = (await new JsonEventStore(fixture.dataDirectory).read())[0]!;
    await new JsonEventStore(fixture.dataDirectory).append([{
      ...existing, id: '7'.repeat(64), localSha: '8'.repeat(40),
      commits: [{ sha: '8'.repeat(40), subject: 'Late activity', authorName: 'Test User' }],
    }]);
    await expect(service.preview({ draftId: fixture.draftId, version: 1, selectedNextActionIndexes: [] }))
      .resolves.toMatchObject({ sourceChangedAfterApproval: true });
  });

  it('does not choose or modify one page when a legacy day has multiple Work Logs', async () => {
    const fixture = await draftFixture();
    const store = new JsonPublicationStore(fixture.dataDirectory);
    const items = ['legacy-work-0', 'legacy-work-1'];
    await store.initialize({
      draftId: fixture.draftId, draftVersion: 1, workDate: '2026-10-24', timezone: 'Asia/Seoul',
      dailyKey: 'legacy', selectedNextActionIndexes: [], previewFingerprint: '9'.repeat(64),
      items: items.map((localId, sourceIndex) => ({ localId, kind: 'WORK_LOG' as const, sourceIndex })),
      timestamp: '2026-10-24T02:00:00.000Z',
    });
    for (const [index, localId] of items.entries()) {
      await store.markItem({
        draftId: fixture.draftId, draftVersion: 1, localId, status: 'SYNCED',
        externalId: `legacy-page-${index}`, timestamp: `2026-10-24T02:0${index + 1}:00.000Z`,
      });
    }
    const notion = new FakeNotion();
    await expect(new NotionPublicationService(fixture.dataDirectory, notion).preview({
      draftId: fixture.draftId, version: 1, selectedNextActionIndexes: [],
    })).rejects.toMatchObject({ code: 'DAILY_PUBLICATION_CONFLICT' });
    expect(notion.createdWorkLogs).toHaveLength(0);
    expect((await store.get(fixture.draftId, 1))?.items).toHaveLength(2);
  });

  it('records rate limits as partial failure and retries only failed items', async () => {
    const fixture = await draftFixture();
    const notion = new FakeNotion();
    notion.failTask = new NotionAdapterError('RATE_LIMITED', 'rate limited', true);
    notion.failTaskOnce = true;
    const service = new NotionPublicationService(fixture.dataDirectory, notion);
    const input = { draftId: fixture.draftId, version: 1, selectedNextActionIndexes: [0] };
    const preview = await service.preview(input);
    const first = await service.publish({ ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true });
    expect(first).toMatchObject({ status: 'PARTIAL', synced: 1, failed: 1 });
    expect(first.record.items.find(({ kind }) => kind === 'TASK')).toMatchObject({ errorCode: 'RATE_LIMITED' });

    notion.failTask = undefined;
    const retried = await service.publish({ ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true });
    expect(retried).toMatchObject({ status: 'SYNCED', synced: 2, failed: 0, skipped: 1 });
    expect(notion.createdWorkLogs).toHaveLength(1);
  });

  it('recovers without duplication when local persistence fails after a remote create', async () => {
    const fixture = await draftFixture();
    const notion = new FakeNotion();
    let renameCount = 0;
    const failingStore = new JsonPublicationStore(fixture.dataDirectory, {
      rename: async (oldPath, newPath) => {
        renameCount += 1;
        if (renameCount >= 2) throw new Error('simulated local persistence failure');
        const { rename } = await import('node:fs/promises');
        await rename(oldPath, newPath);
      },
    });
    const failingService = new NotionPublicationService(
      fixture.dataDirectory,
      notion,
      new JsonDraftStore(fixture.dataDirectory),
      new JsonEventStore(fixture.dataDirectory),
      failingStore,
    );
    const input = { draftId: fixture.draftId, version: 1, selectedNextActionIndexes: [] };
    const preview = await failingService.preview(input);
    await expect(failingService.publish({
      ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true,
    })).rejects.toThrow('simulated local persistence failure');
    expect(notion.createdWorkLogs).toHaveLength(1);

    const recovered = await new NotionPublicationService(fixture.dataDirectory, notion).publish({
      ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true,
    });
    expect(recovered.status).toBe('SYNCED');
    expect(notion.createdWorkLogs).toHaveLength(1);
  });
});
