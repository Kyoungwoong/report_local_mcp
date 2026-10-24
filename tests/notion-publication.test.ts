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

  async createWorkLog(input: CreateWorkLogInput): Promise<string> {
    this.createdWorkLogs.push(input.localId);
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
  await new JsonEventStore(dataDirectory).append([event]);
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
    }],
    nextActions: ['Add Calendar adapter', 'Review release notes'],
    sourceEventIds: [event.id],
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
    expect(preview.tasks.map(({ title }) => title)).toEqual(['Review release notes']);

    const first = await service.publish({ ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true });
    const second = await service.publish({ ...input, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true });
    expect(first.status).toBe('SYNCED');
    expect(second).toMatchObject({ status: 'SYNCED', skipped: 2 });
    expect(notion.createdWorkLogs).toHaveLength(1);
    expect(notion.createdTasks).toHaveLength(1);
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
