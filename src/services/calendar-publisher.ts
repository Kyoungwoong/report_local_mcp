import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  CalendarAdapterError,
  type CalendarConnectionValidation,
  type CalendarEventInput,
  type CalendarEventLookup,
  type CalendarPort,
} from '../adapters/calendar.js';
import type { DailyDraft, DraftRecord } from '../drafts/types.js';
import type { CalendarPublicationRecord } from '../publication/calendar-types.js';
import { dailyCalendarLocalId, dailyPublicationKey } from '../publication/daily-key.js';
import { JsonCalendarPublicationStore } from '../storage/calendar-publication-store.js';
import { JsonDraftStore } from '../storage/draft-store.js';
import { JsonEventStore, withFileLock } from '../storage/json-store.js';
import { JsonPublicationStore } from '../storage/publication-store.js';
import { getDailyActivity } from './activity.js';

export type CalendarPublicationErrorCode =
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_NOT_APPROVED'
  | 'APPROVED_VERSION_MISMATCH'
  | 'PREVIEW_MISMATCH'
  | 'PUBLICATION_NOT_AUTHORIZED'
  | 'CALENDAR_NOT_CONFIGURED'
  | 'CALENDAR_NOT_FOUND'
  | 'CALENDAR_CONNECTION_INVALID'
  | 'DAILY_PUBLICATION_CONFLICT'
  | 'STORAGE_ERROR';

export class CalendarPublicationError extends Error {
  constructor(readonly code: CalendarPublicationErrorCode, message: string) {
    super(message);
    this.name = 'CalendarPublicationError';
  }
}

export type CalendarEventDisposition =
  | 'CREATE'
  | 'SKIP_EXISTING'
  | 'RECOVER_REMOTE'
  | 'RECREATE_DELETED'
  | 'RECREATE_MOVED';

export type CalendarPublicationPreview = {
  draftId: string;
  draftVersion: number;
  workDate: string;
  timezone: string;
  dailyKey: string;
  localId: string;
  calendar: { identifier: string; title: string; sourceTitle: string };
  event: { title: string; notes: string; notionWorkLogLinks: string[] };
  eventDisposition: CalendarEventDisposition;
  sourceChangedAfterApproval: boolean;
  previewFingerprint: string;
  confirmationPhrase: string;
  connection: CalendarConnectionValidation;
};

export type CalendarPublicationResult = {
  status: 'SYNCED' | 'FAILED';
  action: 'CREATED' | 'RECOVERED' | 'SKIPPED' | 'RECREATED_DELETED' | 'RECREATED_MOVED' | 'FAILED';
  record: CalendarPublicationRecord;
  sourceChangedAfterApproval: boolean;
};

export type CalendarPublicationStatus =
  | { status: 'NOT_STARTED' }
  | {
    status: 'SYNCED' | 'FAILED' | 'MISSING' | 'MOVED' | 'CONFLICT' | 'UNAVAILABLE';
    record: CalendarPublicationRecord;
    sourceChangedAfterApproval: boolean;
    remoteErrorCode?: string;
  };

export interface CalendarPublicationPort {
  preview(input: { draftId: string; version: number }): Promise<CalendarPublicationPreview>;
  publish(input: {
    draftId: string;
    version: number;
    previewFingerprint: string;
    publicationAuthorized: boolean;
  }): Promise<CalendarPublicationResult>;
  getStatus(draftId: string, version: number): Promise<CalendarPublicationStatus>;
}

type Clock = () => Date;

function latestDraft(records: DraftRecord[], draftId: string): DailyDraft {
  const record = records.find((candidate) => candidate.draftId === draftId);
  if (!record) throw new CalendarPublicationError('DRAFT_NOT_FOUND', `Draft not found: ${draftId}`);
  return record.revisions[record.revisions.length - 1]!;
}

function validateApprovedVersion(draft: DailyDraft, version: number): void {
  if (draft.status !== 'APPROVED') {
    throw new CalendarPublicationError('DRAFT_NOT_APPROVED', 'Only an approved draft can be published');
  }
  if (draft.version !== version || draft.approvedVersion !== version) {
    throw new CalendarPublicationError(
      'APPROVED_VERSION_MISMATCH',
      `Only approved draft version ${draft.approvedVersion} can be published`,
    );
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function notionUrl(pageId: string): string {
  return `https://www.notion.so/${pageId.replaceAll('-', '')}`;
}

function recordDate(record: CalendarPublicationRecord, drafts: DraftRecord[]): { workDate: string; timezone: string } | undefined {
  if (record.timezone) return { workDate: record.workDate, timezone: record.timezone };
  const draft = drafts.find(({ draftId }) => draftId === record.draftId);
  return draft ? { workDate: draft.workDate, timezone: draft.timezone } : undefined;
}

function localCalendarClaim(
  draft: DailyDraft,
  draftRecords: DraftRecord[],
  records: CalendarPublicationRecord[],
): CalendarPublicationRecord | undefined {
  let own: CalendarPublicationRecord | undefined;
  for (const record of records) {
    const date = recordDate(record, draftRecords);
    if (!date || date.workDate !== draft.workDate || date.timezone !== draft.timezone) continue;
    if (record.draftId === draft.draftId && record.draftVersion === draft.version) {
      own = record;
      continue;
    }
    if (record.status === 'SYNCED' && record.eventIdentifier) {
      throw new CalendarPublicationError(
        'DAILY_PUBLICATION_CONFLICT',
        `A Calendar event for ${draft.workDate} (${draft.timezone}) was already published by draft ${record.draftId} v${record.draftVersion}`,
      );
    }
  }
  return own;
}

function disposition(lookup: CalendarEventLookup, own?: CalendarPublicationRecord): CalendarEventDisposition {
  if (!own) {
    if (lookup.status !== 'MISSING') {
      throw new CalendarPublicationError(
        'DAILY_PUBLICATION_CONFLICT',
        `A different Local DevLog event already claims this work date${lookup.eventIdentifier ? ` (${lookup.eventIdentifier})` : ''}`,
      );
    }
    return 'CREATE';
  }
  if (lookup.status === 'CONFLICT') {
    throw new CalendarPublicationError(
      'DAILY_PUBLICATION_CONFLICT',
      `A different Local DevLog event already claims this work date${lookup.eventIdentifier ? ` (${lookup.eventIdentifier})` : ''}`,
    );
  }
  if (lookup.status === 'MATCH') {
    return own.status === 'SYNCED' && own.eventIdentifier === lookup.eventIdentifier
      ? 'SKIP_EXISTING'
      : 'RECOVER_REMOTE';
  }
  if (lookup.status === 'MOVED') return 'RECREATE_MOVED';
  return own.eventIdentifier ? 'RECREATE_DELETED' : 'CREATE';
}

async function sourceChanged(draft: DailyDraft, dataDirectory: string): Promise<boolean> {
  const activity = await getDailyActivity(draft.workDate, dataDirectory, draft.timezone);
  return activity.sourceFingerprint !== draft.sourceFingerprint;
}

export function calendarPublicationPhrase(draftId: string, version: number, previewFingerprint: string): string {
  return `PUBLISH_CALENDAR:${draftId}:v${version}:${previewFingerprint.slice(0, 12)}`;
}

export class CalendarPublicationService implements CalendarPublicationPort {
  constructor(
    private readonly dataDirectory: string,
    private readonly calendar: CalendarPort,
    private readonly drafts = new JsonDraftStore(dataDirectory),
    private readonly events = new JsonEventStore(dataDirectory),
    private readonly calendarPublications = new JsonCalendarPublicationStore(dataDirectory),
    private readonly notionPublications = new JsonPublicationStore(dataDirectory),
    private readonly clock: Clock = () => new Date(),
  ) {}

  async preview(input: { draftId: string; version: number }): Promise<CalendarPublicationPreview> {
    const draftRecords = await this.drafts.read();
    const draft = latestDraft(draftRecords, input.draftId);
    validateApprovedVersion(draft, input.version);
    const own = localCalendarClaim(draft, draftRecords, await this.calendarPublications.read());
    const connection = await this.calendar.validateConnection(false);
    if (connection.authorizationStatus !== 'FULL_ACCESS') {
      throw new CalendarPublicationError(
        'CALENDAR_CONNECTION_INVALID',
        `Calendar full access is not ready (${connection.authorizationStatus})`,
      );
    }
    if (!connection.configured) {
      throw new CalendarPublicationError(
        connection.configurationPresent ? 'CALENDAR_NOT_FOUND' : 'CALENDAR_NOT_CONFIGURED',
        connection.configurationPresent
          ? 'The configured Calendar no longer exists; select it again'
          : 'Select a writable Calendar before previewing publication',
      );
    }
    if (!connection.valid) {
      throw new CalendarPublicationError(
        'CALENDAR_CONNECTION_INVALID',
        `Calendar connection is not ready (${connection.authorizationStatus})`,
      );
    }

    const eventNames = new Map((await this.events.read()).map((event) => [event.id, event.repositoryName]));
    const notion = await this.notionPublications.get(draft.draftId, draft.version);
    const notionWorkLogLinks = notion?.items
      .filter(({ kind, status, externalId }) => kind === 'WORK_LOG' && status === 'SYNCED' && externalId)
      .map(({ externalId }) => notionUrl(externalId!)) ?? [];
    const dailyKey = dailyPublicationKey(draft.workDate, draft.timezone);
    const localId = own?.localId ?? dailyCalendarLocalId(draft.workDate, draft.timezone);
    const title = `개발 일지 | ${draft.workDate}`;
    const workLines = draft.workItems.flatMap((item) => {
      const repository = item.sourceEventIds.map((id) => eventNames.get(id)).find(Boolean) ?? item.repositoryId;
      return [`- ${repository} · ${item.title}`, `  ${item.details || '추가 상세 내용 없음'}`];
    });
    const nextActionLines = draft.nextActions.length > 0
      ? draft.nextActions.map((action) => `- ${action}`)
      : ['- 없음'];
    const notionLines = notionWorkLogLinks.length > 0
      ? notionWorkLogLinks.map((link) => `- ${link}`)
      : ['- 없음'];
    const notes = [
      `작업 날짜: ${draft.workDate}`,
      `시간대: ${draft.timezone}`,
      '',
      '하루 작업 요약',
      draft.summary,
      '',
      'Repository별 작업 내용',
      ...workLines,
      '',
      '다음 작업 목록',
      ...nextActionLines,
      '',
      'Notion Work Logs',
      ...notionLines,
      '',
      `Draft: ${draft.draftId} v${draft.version}`,
      `Local DevLog Calendar ID: ${localId}`,
    ].join('\n');
    const calendar = {
      identifier: connection.configured.identifier,
      title: connection.configured.title,
      sourceTitle: connection.configured.sourceTitle,
    };
    const eventInput: CalendarEventInput = {
      calendarIdentifier: calendar.identifier,
      localId,
      workDate: draft.workDate,
      timezone: draft.timezone,
      title,
      notes,
    };
    const eventDisposition = disposition(await this.calendar.findEvent(eventInput, own?.eventIdentifier), own);
    const sourceChangedAfterApproval = await sourceChanged(draft, this.dataDirectory);
    const previewValue = {
      draftId: draft.draftId,
      draftVersion: draft.version,
      workDate: draft.workDate,
      timezone: draft.timezone,
      dailyKey,
      localId,
      calendar,
      event: { title, notes, notionWorkLogLinks },
      eventDisposition,
      sourceChangedAfterApproval,
    };
    const previewFingerprint = fingerprint({
      draftId: previewValue.draftId,
      draftVersion: previewValue.draftVersion,
      workDate: previewValue.workDate,
      timezone: previewValue.timezone,
      dailyKey: previewValue.dailyKey,
      localId: previewValue.localId,
      calendar: previewValue.calendar,
      event: previewValue.event,
      sourceChangedAfterApproval: previewValue.sourceChangedAfterApproval,
    });
    return {
      ...previewValue,
      previewFingerprint,
      confirmationPhrase: calendarPublicationPhrase(draft.draftId, draft.version, previewFingerprint),
      connection,
    };
  }

  private eventInput(preview: CalendarPublicationPreview): CalendarEventInput {
    return {
      calendarIdentifier: preview.calendar.identifier,
      localId: preview.localId,
      workDate: preview.workDate,
      timezone: preview.timezone,
      title: preview.event.title,
      notes: preview.event.notes,
    };
  }

  async publish(input: {
    draftId: string;
    version: number;
    previewFingerprint: string;
    publicationAuthorized: boolean;
  }): Promise<CalendarPublicationResult> {
    if (!input.publicationAuthorized) {
      throw new CalendarPublicationError('PUBLICATION_NOT_AUTHORIZED', 'Calendar publication requires explicit user confirmation');
    }
    const preview = await this.preview(input);
    if (preview.previewFingerprint !== input.previewFingerprint) {
      throw new CalendarPublicationError('PREVIEW_MISMATCH', 'Calendar preview changed; preview and confirm it again');
    }
    return withFileLock(join(this.dataDirectory, 'calendar-publication-run.lock'), async () => {
      let record = await this.calendarPublications.initialize({
        draftId: preview.draftId,
        draftVersion: preview.draftVersion,
        localId: preview.localId,
        previewFingerprint: preview.previewFingerprint,
        calendarIdentifier: preview.calendar.identifier,
        workDate: preview.workDate,
        timezone: preview.timezone,
        dailyKey: preview.dailyKey,
        timestamp: this.clock().toISOString(),
      });
      const hadExistingEvent = record.eventIdentifier !== undefined;
      const eventInput = this.eventInput(preview);
      try {
        const lookup = await this.calendar.findEvent(eventInput, record.eventIdentifier);
        if (lookup.status === 'CONFLICT') {
          throw new CalendarPublicationError(
            'DAILY_PUBLICATION_CONFLICT',
            `A different Local DevLog event already claims ${preview.workDate} (${preview.timezone})`,
          );
        }
        if (lookup.status === 'MATCH' && lookup.eventIdentifier) {
          if (record.status === 'SYNCED' && record.eventIdentifier === lookup.eventIdentifier) {
            return {
              status: 'SYNCED', action: 'SKIPPED', record,
              sourceChangedAfterApproval: preview.sourceChangedAfterApproval,
            };
          }
          record = await this.calendarPublications.mark({
            draftId: preview.draftId,
            draftVersion: preview.draftVersion,
            status: 'SYNCED',
            eventIdentifier: lookup.eventIdentifier,
            timestamp: this.clock().toISOString(),
          });
          return {
            status: 'SYNCED', action: 'RECOVERED', record,
            sourceChangedAfterApproval: preview.sourceChangedAfterApproval,
          };
        }
        const eventIdentifier = await this.calendar.createEvent(eventInput);
        record = await this.calendarPublications.mark({
          draftId: preview.draftId,
          draftVersion: preview.draftVersion,
          status: 'SYNCED',
          eventIdentifier,
          timestamp: this.clock().toISOString(),
        });
        return {
          status: 'SYNCED',
          action: lookup.status === 'MOVED' ? 'RECREATED_MOVED' : hadExistingEvent ? 'RECREATED_DELETED' : 'CREATED',
          record,
          sourceChangedAfterApproval: preview.sourceChangedAfterApproval,
        };
      } catch (error) {
        if (error instanceof CalendarPublicationError) throw error;
        if (!(error instanceof CalendarAdapterError)) throw error;
        record = await this.calendarPublications.mark({
          draftId: preview.draftId,
          draftVersion: preview.draftVersion,
          status: 'FAILED',
          errorCode: error.code,
          timestamp: this.clock().toISOString(),
        });
        return {
          status: 'FAILED', action: 'FAILED', record,
          sourceChangedAfterApproval: preview.sourceChangedAfterApproval,
        };
      }
    });
  }

  async getStatus(draftId: string, version: number): Promise<CalendarPublicationStatus> {
    const record = await this.calendarPublications.get(draftId, version);
    if (!record) return { status: 'NOT_STARTED' };
    const draft = latestDraft(await this.drafts.read(), draftId);
    const changed = await sourceChanged(draft, this.dataDirectory);
    if (record.status === 'FAILED') return { status: 'FAILED', record, sourceChangedAfterApproval: changed };
    try {
      const preview = await this.preview({ draftId, version });
      if (preview.eventDisposition === 'RECREATE_DELETED') {
        return { status: 'MISSING', record, sourceChangedAfterApproval: changed };
      }
      if (preview.eventDisposition === 'RECREATE_MOVED') {
        return { status: 'MOVED', record, sourceChangedAfterApproval: changed };
      }
      return { status: 'SYNCED', record, sourceChangedAfterApproval: changed };
    } catch (error) {
      return {
        status: error instanceof CalendarPublicationError && error.code === 'DAILY_PUBLICATION_CONFLICT'
          ? 'CONFLICT'
          : 'UNAVAILABLE',
        record,
        sourceChangedAfterApproval: changed,
        remoteErrorCode: error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'CALENDAR_CONNECTION_INVALID',
      };
    }
  }
}
