import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import {
  type ApprovalMethod,
  type DailyDraft,
  type DraftContentInput,
  type DraftRecord,
  type DraftStatus,
  type DraftWorkItem,
} from '../drafts/types.js';
import { JsonDraftStore } from '../storage/draft-store.js';
import { getDailyActivity, isCalendarDate } from './activity.js';

export type DraftErrorCode =
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_ALREADY_EXISTS'
  | 'VERSION_CONFLICT'
  | 'DRAFT_APPROVED'
  | 'DRAFT_REJECTED'
  | 'INVALID_SOURCE'
  | 'SOURCE_CHANGED'
  | 'INVALID_CONFIRMATION'
  | 'NO_SOURCE_ACTIVITY'
  | 'STORAGE_ERROR';

export class DraftError extends Error {
  constructor(readonly code: DraftErrorCode, message: string) {
    super(message);
    this.name = 'DraftError';
  }
}

export type DraftResult = { draft: DailyDraft; revisions: DailyDraft[] };
type Clock = () => Date;
type NormalizedContent = Omit<DraftContentInput, 'workItems'> & { workItems: DraftWorkItem[] };

function latest(record: DraftRecord): DailyDraft {
  return record.revisions[record.revisions.length - 1]!;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function sameValues(left: string[], right: string[]): boolean {
  return JSON.stringify(unique(left)) === JSON.stringify(unique(right));
}

function sameContent(draft: DailyDraft, content: NormalizedContent): boolean {
  return draft.summary === content.summary
    && JSON.stringify(draft.workItems) === JSON.stringify(content.workItems)
    && JSON.stringify(draft.nextActions) === JSON.stringify(content.nextActions)
    && sameValues(draft.sourceEventIds, content.sourceEventIds)
    && draft.sourceFingerprint === content.sourceFingerprint;
}

async function validateAndNormalizeSource(
  workDate: string,
  timezone: string,
  content: DraftContentInput,
  dataDirectory: string,
  requireConfiguredTimezone: boolean,
): Promise<NormalizedContent> {
  if (!isCalendarDate(workDate)) throw new DraftError('INVALID_SOURCE', 'workDate must be a real YYYY-MM-DD date');
  const config = await loadConfig(dataDirectory);
  if (requireConfiguredTimezone && config.timezone !== timezone) {
    throw new DraftError('INVALID_SOURCE', `timezone must match the configured timezone (${config.timezone})`);
  }
  const activity = await getDailyActivity(workDate, dataDirectory, timezone);
  if (activity.activities.length === 0) {
    throw new DraftError('NO_SOURCE_ACTIVITY', 'A draft cannot be saved without Git activity for this date');
  }
  if (activity.sourceFingerprint !== content.sourceFingerprint) {
    throw new DraftError('SOURCE_CHANGED', 'Git activity changed; read get_daily_activity again before saving');
  }

  const activities = new Map(activity.activities.map((item) => [item.eventId, item]));
  for (const eventId of unique(content.sourceEventIds)) {
    if (!activities.has(eventId)) throw new DraftError('INVALID_SOURCE', `Unknown source event for this date: ${eventId}`);
  }
  const itemEventIds = content.workItems.flatMap(({ sourceEventIds }) => sourceEventIds);
  if (!sameValues(content.sourceEventIds, itemEventIds)) {
    throw new DraftError('INVALID_SOURCE', 'workItems must account for exactly the top-level sourceEventIds');
  }

  const workItems = content.workItems.map((item): DraftWorkItem => {
    const referenced = unique(item.sourceEventIds).map((eventId) => {
      const activityItem = activities.get(eventId);
      if (!activityItem) throw new DraftError('INVALID_SOURCE', `Unknown work item source event: ${eventId}`);
      if (activityItem.repository.id !== item.repositoryId) {
        throw new DraftError('INVALID_SOURCE', `Source event ${eventId} belongs to a different repository`);
      }
      return activityItem;
    });
    return {
      ...item,
      sourceEventIds: unique(item.sourceEventIds),
      verificationStatus: referenced.every(({ verification }) => verification.status === 'REMOTE_MATCH')
        ? 'REMOTE_MATCH'
        : 'UNCONFIRMED',
    };
  });

  return {
    summary: content.summary,
    workItems,
    nextActions: content.nextActions,
    sourceEventIds: unique(content.sourceEventIds),
    sourceFingerprint: content.sourceFingerprint,
  };
}

export class DailyDraftService {
  constructor(
    private readonly dataDirectory: string,
    private readonly store = new JsonDraftStore(dataDirectory),
    private readonly clock: Clock = () => new Date(),
    private readonly createId: () => string = randomUUID,
  ) {}

  async save(input: DraftContentInput & { workDate: string; timezone: string }): Promise<DraftResult> {
    const content = await validateAndNormalizeSource(input.workDate, input.timezone, input, this.dataDirectory, true);
    return this.store.update((records) => {
      const existing = records.find(({ workDate, timezone }) => workDate === input.workDate && timezone === input.timezone);
      if (existing) {
        const current = latest(existing);
        if (sameContent(current, content)) return { records, result: { draft: current, revisions: existing.revisions }, changed: false };
        throw new DraftError('DRAFT_ALREADY_EXISTS', 'A draft already exists for this date and timezone; update it instead');
      }
      const timestamp = this.clock().toISOString();
      const draft: DailyDraft = {
        draftId: this.createId(),
        workDate: input.workDate,
        timezone: input.timezone,
        ...content,
        version: 1,
        status: 'PENDING',
        createdAt: timestamp,
        updatedAt: timestamp,
        approvedAt: null,
        approvedVersion: null,
        approvalMethod: null,
        approvalWarnings: [],
      };
      const record: DraftRecord = {
        draftId: draft.draftId,
        workDate: draft.workDate,
        timezone: draft.timezone,
        revisions: [draft],
      };
      return { records: [...records, record], result: { draft, revisions: [draft] }, changed: true };
    });
  }

  async get(draftId: string): Promise<DraftResult> {
    const record = (await this.store.read()).find((item) => item.draftId === draftId);
    if (!record) throw new DraftError('DRAFT_NOT_FOUND', `Draft not found: ${draftId}`);
    return { draft: latest(record), revisions: record.revisions };
  }

  async list(filters: { workDate?: string; timezone?: string; status?: DraftStatus } = {}): Promise<DailyDraft[]> {
    return (await this.store.read()).map(latest).filter((draft) =>
      (!filters.workDate || draft.workDate === filters.workDate)
      && (!filters.timezone || draft.timezone === filters.timezone)
      && (!filters.status || draft.status === filters.status))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async update(input: DraftContentInput & {
    draftId: string;
    expectedVersion: number;
    status: 'PENDING' | 'REJECTED';
  }): Promise<DraftResult> {
    const existing = await this.get(input.draftId);
    if (existing.draft.status === 'APPROVED') throw new DraftError('DRAFT_APPROVED', 'Approved drafts are immutable');
    if (existing.draft.version !== input.expectedVersion) {
      throw new DraftError('VERSION_CONFLICT', `Expected version ${input.expectedVersion}, current version is ${existing.draft.version}`);
    }
    const content = await validateAndNormalizeSource(
      existing.draft.workDate,
      existing.draft.timezone,
      input,
      this.dataDirectory,
      false,
    );

    return this.store.update((records) => {
      const index = records.findIndex(({ draftId }) => draftId === input.draftId);
      if (index < 0) throw new DraftError('DRAFT_NOT_FOUND', `Draft not found: ${input.draftId}`);
      const record = records[index]!;
      const current = latest(record);
      if (current.status === 'APPROVED') throw new DraftError('DRAFT_APPROVED', 'Approved drafts are immutable');
      if (current.version !== input.expectedVersion) {
        throw new DraftError('VERSION_CONFLICT', `Expected version ${input.expectedVersion}, current version is ${current.version}`);
      }
      const next: DailyDraft = {
        ...current,
        ...content,
        version: current.version + 1,
        status: input.status,
        updatedAt: this.clock().toISOString(),
        approvedAt: null,
        approvedVersion: null,
        approvalMethod: null,
        approvalWarnings: [],
      };
      const nextRecord = { ...record, revisions: [...record.revisions, next] };
      const nextRecords = [...records];
      nextRecords[index] = nextRecord;
      return { records: nextRecords, result: { draft: next, revisions: nextRecord.revisions }, changed: true };
    });
  }

  async approve(draftId: string, version: number, approvalMethod: ApprovalMethod): Promise<DraftResult> {
    const existing = await this.get(draftId);
    if (existing.draft.status === 'APPROVED') {
      if (existing.draft.approvedVersion === version) return existing;
      throw new DraftError('VERSION_CONFLICT', `Approved version is ${existing.draft.approvedVersion}`);
    }
    if (existing.draft.status === 'REJECTED') throw new DraftError('DRAFT_REJECTED', 'Rejected drafts must be reopened before approval');
    if (existing.draft.version !== version) {
      throw new DraftError('VERSION_CONFLICT', `Expected version ${version}, current version is ${existing.draft.version}`);
    }
    const activity = await getDailyActivity(existing.draft.workDate, this.dataDirectory, existing.draft.timezone);
    const approvalWarnings: DailyDraft['approvalWarnings'] = activity.sourceFingerprint === existing.draft.sourceFingerprint
      ? []
      : ['SOURCE_CHANGED_AFTER_DRAFT'];

    return this.store.update((records) => {
      const index = records.findIndex((record) => record.draftId === draftId);
      if (index < 0) throw new DraftError('DRAFT_NOT_FOUND', `Draft not found: ${draftId}`);
      const record = records[index]!;
      const current = latest(record);
      if (current.status === 'APPROVED') {
        if (current.approvedVersion === version) return { records, result: { draft: current, revisions: record.revisions }, changed: false };
        throw new DraftError('VERSION_CONFLICT', `Approved version is ${current.approvedVersion}`);
      }
      if (current.status === 'REJECTED') throw new DraftError('DRAFT_REJECTED', 'Rejected drafts must be reopened before approval');
      if (current.version !== version) {
        throw new DraftError('VERSION_CONFLICT', `Expected version ${version}, current version is ${current.version}`);
      }
      const timestamp = this.clock().toISOString();
      const approved: DailyDraft = {
        ...current,
        status: 'APPROVED',
        approvedAt: timestamp,
        approvedVersion: current.version,
        approvalMethod,
        approvalWarnings,
        updatedAt: timestamp,
      };
      const nextRecord = { ...record, revisions: [...record.revisions.slice(0, -1), approved] };
      const nextRecords = [...records];
      nextRecords[index] = nextRecord;
      return { records: nextRecords, result: { draft: approved, revisions: nextRecord.revisions }, changed: true };
    });
  }
}

export function approvalPhrase(draftId: string, version: number): string {
  return `APPROVE_DAILY_DRAFT:${draftId}:v${version}`;
}
