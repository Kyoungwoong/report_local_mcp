import { mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CalendarAdapterError,
  type CalendarConnectionValidation,
  type CalendarEventInput,
  type CalendarEventLookup,
  type CalendarPort,
} from '../src/adapters/calendar.js';
import { saveConfig } from '../src/config/index.js';
import type { PushAttempt } from '../src/git/types.js';
import { getDailyActivity } from '../src/services/activity.js';
import { CalendarPublicationService } from '../src/services/calendar-publisher.js';
import { DailyDraftService } from '../src/services/daily-log.js';
import { JsonCalendarPublicationStore } from '../src/storage/calendar-publication-store.js';
import { JsonDraftStore } from '../src/storage/draft-store.js';
import { JsonEventStore } from '../src/storage/json-store.js';
import { JsonPublicationStore } from '../src/storage/publication-store.js';

const directories: string[] = [];
const connection: CalendarConnectionValidation = {
  platform: 'darwin',
  authorizationStatus: 'FULL_ACCESS',
  configurationPresent: true,
  configured: {
    identifier: 'calendar-1', title: 'Development', sourceTitle: 'iCloud', allowsContentModifications: true,
  },
  calendars: [{
    identifier: 'calendar-1', title: 'Development', sourceTitle: 'iCloud', allowsContentModifications: true,
  }],
  valid: true,
};

class FakeCalendar implements CalendarPort {
  readonly events = new Map<string, { identifier: string; calendarIdentifier: string; input: CalendarEventInput }>();
  createCalls = 0;
  failCreate?: CalendarAdapterError;
  lookupOverride?: CalendarEventLookup;

  async validateConnection(): Promise<CalendarConnectionValidation> { return connection; }
  async listCalendars() { return connection.calendars; }
  async findEvent(input: CalendarEventInput, known?: string): Promise<CalendarEventLookup> {
    if (this.lookupOverride) return this.lookupOverride;
    const found = [...this.events.values()].find(({ identifier, input: saved }) =>
      identifier === known || saved.localId === input.localId);
    return found
      ? { status: found.calendarIdentifier === input.calendarIdentifier ? 'MATCH' : 'MOVED', eventIdentifier: found.identifier, calendarIdentifier: found.calendarIdentifier }
      : { status: 'MISSING' };
  }
  async createEvent(input: CalendarEventInput): Promise<string> {
    if (this.failCreate) throw this.failCreate;
    this.createCalls += 1;
    const identifier = `event-${this.createCalls}`;
    this.events.set(input.localId, { identifier, calendarIdentifier: input.calendarIdentifier, input });
    return identifier;
  }
}

async function fixture(approve = true) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-devlog-calendar-'));
  directories.push(dataDirectory);
  await saveConfig({
    version: 1, timezone: 'Asia/Seoul', repositories: [],
    calendar: { identifier: 'calendar-1', title: 'Development', sourceTitle: 'iCloud' },
  }, dataDirectory);
  const event: PushAttempt = {
    id: '1'.repeat(64), repositoryId: '2'.repeat(64), repositoryName: 'calendar-example',
    repositoryPath: join(dataDirectory, 'repository'), remoteName: 'origin',
    remoteUrl: 'https://example.invalid/calendar-example.git', localRef: 'refs/heads/main',
    localSha: '3'.repeat(40), remoteRef: 'refs/heads/main', remoteSha: '0'.repeat(40),
    recordedAt: '2026-10-23T15:30:00.000Z',
    commits: [{ sha: '3'.repeat(40), subject: 'Calendar publication', authorName: 'Test User' }],
    commitsTruncated: false,
  };
  await new JsonEventStore(dataDirectory).append([event]);
  const activity = await getDailyActivity('2026-10-24', dataDirectory);
  const drafts = new DailyDraftService(
    dataDirectory, undefined, () => new Date('2026-10-24T02:00:00.000Z'),
    () => '11111111-1111-4111-8111-111111111111',
  );
  const saved = await drafts.save({
    workDate: '2026-10-24', timezone: 'Asia/Seoul', summary: 'Implemented Calendar publication.',
    workItems: [{
      repositoryId: event.repositoryId, title: 'Calendar adapter',
      details: 'Added an all-day EventKit publication path.', sourceEventIds: [event.id],
    }],
    nextActions: ['Verify Calendar publication'], sourceEventIds: [event.id],
    sourceFingerprint: activity.sourceFingerprint,
  });
  if (approve) await drafts.approve(saved.draft.draftId, 1, 'MCP_ELICITATION');
  return { dataDirectory, draftId: saved.draft.draftId, version: 1 };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Calendar publication service', () => {
  it('rejects unapproved drafts, wrong versions, and missing publication authorization', async () => {
    const pending = await fixture(false);
    await expect(new CalendarPublicationService(pending.dataDirectory, new FakeCalendar()).preview({
      draftId: pending.draftId, version: 1,
    })).rejects.toMatchObject({ code: 'DRAFT_NOT_APPROVED' });
    const approved = await fixture();
    const service = new CalendarPublicationService(approved.dataDirectory, new FakeCalendar());
    await expect(service.preview({ draftId: approved.draftId, version: 2 }))
      .rejects.toMatchObject({ code: 'APPROVED_VERSION_MISMATCH' });
    const preview = await service.preview({ draftId: approved.draftId, version: 1 });
    await expect(service.publish({
      draftId: approved.draftId, version: 1,
      previewFingerprint: preview.previewFingerprint, publicationAuthorized: false,
    })).rejects.toMatchObject({ code: 'PUBLICATION_NOT_AUTHORIZED' });
  });

  it('builds an all-day preview with repository details and synced Notion links', async () => {
    const value = await fixture();
    const notion = new JsonPublicationStore(value.dataDirectory);
    await notion.initialize({
      draftId: value.draftId, draftVersion: 1, selectedNextActionIndexes: [],
      previewFingerprint: 'a'.repeat(64),
      items: [{ localId: `${value.draftId}:v1:work:0`, kind: 'WORK_LOG', sourceIndex: 0 }],
      timestamp: '2026-10-24T02:00:00.000Z',
    });
    await notion.markItem({
      draftId: value.draftId, draftVersion: 1, localId: `${value.draftId}:v1:work:0`,
      status: 'SYNCED', externalId: '12345678-1234-1234-1234-123456789012',
      timestamp: '2026-10-24T02:01:00.000Z',
    });
    const preview = await new CalendarPublicationService(value.dataDirectory, new FakeCalendar()).preview({
      draftId: value.draftId, version: 1,
    });
    expect(preview).toMatchObject({ workDate: '2026-10-24', timezone: 'Asia/Seoul' });
    expect(preview.event.title).toBe('개발 일지 | 2026-10-24');
    expect(preview.event.notes).toContain('calendar-example · Calendar adapter');
    expect(preview.event.notionWorkLogLinks).toEqual(['https://www.notion.so/12345678123412341234123456789012']);
  });

  it('publishes once, skips duplicates, and keeps the selected timezone date', async () => {
    const value = await fixture();
    const calendar = new FakeCalendar();
    const service = new CalendarPublicationService(value.dataDirectory, calendar);
    const preview = await service.preview({ draftId: value.draftId, version: 1 });
    const input = { draftId: value.draftId, version: 1, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true };
    await expect(service.publish(input)).resolves.toMatchObject({ status: 'SYNCED', action: 'CREATED' });
    await expect(service.publish(input)).resolves.toMatchObject({ status: 'SYNCED', action: 'SKIPPED' });
    expect(calendar.createCalls).toBe(1);
    expect([...calendar.events.values()][0]?.input).toMatchObject({ workDate: '2026-10-24', timezone: 'Asia/Seoul' });
  });

  it('records EventKit failure without changing Notion success', async () => {
    const value = await fixture();
    const notion = new JsonPublicationStore(value.dataDirectory);
    const notionRecord = await notion.initialize({
      draftId: value.draftId, draftVersion: 1, selectedNextActionIndexes: [], previewFingerprint: 'b'.repeat(64),
      items: [{ localId: 'notion-work', kind: 'WORK_LOG', sourceIndex: 0 }], timestamp: '2026-10-24T02:00:00.000Z',
    });
    await notion.markItem({
      draftId: value.draftId, draftVersion: 1, localId: notionRecord.items[0]!.localId,
      status: 'SYNCED', externalId: 'notion-page', timestamp: '2026-10-24T02:01:00.000Z',
    });
    const calendar = new FakeCalendar();
    calendar.failCreate = new CalendarAdapterError('EVENTKIT_SAVE_FAILED', 'failed');
    const service = new CalendarPublicationService(value.dataDirectory, calendar);
    const preview = await service.preview({ draftId: value.draftId, version: 1 });
    await expect(service.publish({
      draftId: value.draftId, version: 1, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true,
    })).resolves.toMatchObject({ status: 'FAILED', record: { errorCode: 'EVENTKIT_SAVE_FAILED' } });
    await expect(notion.get(value.draftId, 1)).resolves.toMatchObject({ items: [{ status: 'SYNCED' }] });
  });

  it('keeps Calendar success when a separate Notion item is failed', async () => {
    const value = await fixture();
    const notion = new JsonPublicationStore(value.dataDirectory);
    await notion.initialize({
      draftId: value.draftId, draftVersion: 1, selectedNextActionIndexes: [], previewFingerprint: 'd'.repeat(64),
      items: [{ localId: 'notion-failed', kind: 'WORK_LOG', sourceIndex: 0 }], timestamp: '2026-10-24T02:00:00.000Z',
    });
    await notion.markItem({
      draftId: value.draftId, draftVersion: 1, localId: 'notion-failed',
      status: 'FAILED', errorCode: 'NOTION_API_ERROR', timestamp: '2026-10-24T02:01:00.000Z',
    });
    const calendar = new FakeCalendar();
    const service = new CalendarPublicationService(value.dataDirectory, calendar);
    const preview = await service.preview({ draftId: value.draftId, version: 1 });
    await expect(service.publish({
      draftId: value.draftId, version: 1, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true,
    })).resolves.toMatchObject({ status: 'SYNCED' });
    await expect(notion.get(value.draftId, 1)).resolves.toMatchObject({ items: [{ status: 'FAILED' }] });
    await expect(service.getStatus(value.draftId, 1)).resolves.toMatchObject({ status: 'SYNCED' });
  });

  it('recovers after remote success and local persistence failure', async () => {
    const value = await fixture();
    const calendar = new FakeCalendar();
    let renameCount = 0;
    const failingStore = new JsonCalendarPublicationStore(value.dataDirectory, {
      rename: async (oldPath, newPath) => {
        renameCount += 1;
        if (renameCount >= 2) throw new Error('simulated local persistence failure');
        await rename(oldPath, newPath);
      },
    });
    const failing = new CalendarPublicationService(
      value.dataDirectory, calendar, new JsonDraftStore(value.dataDirectory),
      new JsonEventStore(value.dataDirectory), failingStore,
    );
    const preview = await failing.preview({ draftId: value.draftId, version: 1 });
    const input = { draftId: value.draftId, version: 1, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true };
    await expect(failing.publish(input)).rejects.toThrow('simulated local persistence failure');
    expect(calendar.createCalls).toBe(1);
    await expect(new CalendarPublicationService(value.dataDirectory, calendar).publish(input))
      .resolves.toMatchObject({ status: 'SYNCED', action: 'RECOVERED' });
    expect(calendar.createCalls).toBe(1);
  });

  it('recreates deleted or moved events only on another authorized publication', async () => {
    const value = await fixture();
    const calendar = new FakeCalendar();
    const service = new CalendarPublicationService(value.dataDirectory, calendar);
    const preview = await service.preview({ draftId: value.draftId, version: 1 });
    const input = { draftId: value.draftId, version: 1, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true };
    await service.publish(input);
    calendar.events.clear();
    await expect(service.getStatus(value.draftId, 1)).resolves.toMatchObject({ status: 'MISSING' });
    await expect(service.publish(input)).resolves.toMatchObject({ action: 'RECREATED_DELETED' });
    calendar.lookupOverride = { status: 'MOVED', eventIdentifier: 'moved', calendarIdentifier: 'other' };
    await expect(service.getStatus(value.draftId, 1)).resolves.toMatchObject({ status: 'MOVED' });
    await expect(service.publish(input)).resolves.toMatchObject({ action: 'RECREATED_MOVED' });
  });
});
