import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  NotionAdapterError,
  type CreateTaskInput,
  type CreateWorkLogInput,
  type NotionConnectionValidation,
  type NotionPort,
} from '../adapters/notion.js';
import type { DailyDraft, DraftRecord } from '../drafts/types.js';
import { dailyPublicationKey, dailyWorkLogLocalId, isDailyWorkLogLocalId } from '../publication/daily-key.js';
import type { NotionPublicationRecord, PublicationItemState, PublicationKind } from '../publication/types.js';
import { JsonDraftStore } from '../storage/draft-store.js';
import { JsonEventStore, withFileLock } from '../storage/json-store.js';
import { JsonPublicationStore } from '../storage/publication-store.js';
import { getDailyActivity } from './activity.js';

export type PublicationErrorCode =
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_NOT_APPROVED'
  | 'APPROVED_VERSION_MISMATCH'
  | 'INVALID_SELECTION'
  | 'PREVIEW_MISMATCH'
  | 'PUBLICATION_NOT_AUTHORIZED'
  | 'NOTION_SCHEMA_INVALID'
  | 'DAILY_PUBLICATION_CONFLICT'
  | 'PUBLICATION_NOT_FOUND'
  | 'STORAGE_ERROR';

export class PublicationError extends Error {
  constructor(readonly code: PublicationErrorCode, message: string) {
    super(message);
    this.name = 'PublicationError';
  }
}

export type WorkLogPreviewItem = CreateWorkLogInput & { kind: 'WORK_LOG'; sourceIndex: 0 };
export type TaskPreviewItem = CreateTaskInput & { kind: 'TASK'; sourceIndex: number };
export type WorkLogDisposition = 'CREATE' | 'SKIP_EXISTING' | 'RECOVER_REMOTE';

export type NotionPublicationPreview = {
  draftId: string;
  draftVersion: number;
  workDate: string;
  timezone: string;
  dailyKey: string;
  selectedNextActionIndexes: number[];
  workLogs: WorkLogPreviewItem[];
  tasks: TaskPreviewItem[];
  workLogDisposition: WorkLogDisposition;
  existingWorkLog?: { localId: string; externalId: string; attempts: number; updatedAt: string };
  sourceChangedAfterApproval: boolean;
  previewFingerprint: string;
  confirmationPhrase: string;
  notion: NotionConnectionValidation;
};

export type NotionPublicationResult = {
  status: 'SYNCED' | 'PARTIAL' | 'FAILED';
  record: NotionPublicationRecord;
  synced: number;
  failed: number;
  skipped: number;
  sourceChangedAfterApproval: boolean;
};

export type NotionPublicationStatus = NotionPublicationResult
  | { status: 'NOT_STARTED' }
  | { status: 'CONFLICT'; message: string; sourceChangedAfterApproval: boolean };

type Clock = () => Date;

export interface NotionPublicationPort {
  preview(input: {
    draftId: string;
    version: number;
    selectedNextActionIndexes: number[];
  }): Promise<NotionPublicationPreview>;
  publish(input: {
    draftId: string;
    version: number;
    selectedNextActionIndexes: number[];
    previewFingerprint: string;
    publicationAuthorized: boolean;
  }): Promise<NotionPublicationResult>;
  getStatus(draftId: string, version: number): Promise<NotionPublicationStatus>;
}

function latestDraft(records: DraftRecord[], draftId: string): DailyDraft {
  const record = records.find((candidate) => candidate.draftId === draftId);
  if (!record) throw new PublicationError('DRAFT_NOT_FOUND', `Draft not found: ${draftId}`);
  return record.revisions[record.revisions.length - 1]!;
}

function validateApprovedVersion(draft: DailyDraft, version: number): void {
  if (draft.status !== 'APPROVED') throw new PublicationError('DRAFT_NOT_APPROVED', 'Only an approved draft can be published');
  if (draft.version !== version || draft.approvedVersion !== version) {
    throw new PublicationError('APPROVED_VERSION_MISMATCH', `Only approved draft version ${draft.approvedVersion} can be published`);
  }
}

function normalizeSelection(indexes: number[], actionCount: number): number[] {
  const normalized = [...new Set(indexes)].sort((left, right) => left - right);
  if (normalized.some((index) => !Number.isInteger(index) || index < 0 || index >= actionCount)) {
    throw new PublicationError('INVALID_SELECTION', 'A selected next action index is out of range');
  }
  return normalized;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function recordDate(record: NotionPublicationRecord, drafts: DraftRecord[]): { workDate: string; timezone: string } | undefined {
  if (record.workDate && record.timezone) return { workDate: record.workDate, timezone: record.timezone };
  const draft = drafts.find(({ draftId }) => draftId === record.draftId);
  return draft ? { workDate: draft.workDate, timezone: draft.timezone } : undefined;
}

function conflict(message: string): never {
  throw new PublicationError('DAILY_PUBLICATION_CONFLICT', message);
}

function localWorkLogClaim(
  draft: DailyDraft,
  draftRecords: DraftRecord[],
  publicationRecords: NotionPublicationRecord[],
): { record?: NotionPublicationRecord; item?: PublicationItemState } {
  let ownRecord: NotionPublicationRecord | undefined;
  let ownItem: PublicationItemState | undefined;
  for (const record of publicationRecords) {
    const date = recordDate(record, draftRecords);
    if (!date || date.workDate !== draft.workDate || date.timezone !== draft.timezone) continue;
    const published = record.items.filter(({ kind, status, externalId }) =>
      kind === 'WORK_LOG' && status === 'SYNCED' && externalId);
    if (record.draftId !== draft.draftId || record.draftVersion !== draft.version) {
      if (published.length > 0) {
        conflict(`A Work Log for ${draft.workDate} (${draft.timezone}) was already published by draft ${record.draftId} v${record.draftVersion}`);
      }
      continue;
    }
    ownRecord = record;
    if (published.length > 1) {
      conflict(`Multiple legacy Work Logs already exist for ${draft.workDate} (${draft.timezone}); no page was changed`);
    }
    ownItem = published[0];
  }
  return { record: ownRecord, item: ownItem };
}

async function sourceChanged(draft: DailyDraft, dataDirectory: string): Promise<boolean> {
  const activity = await getDailyActivity(draft.workDate, dataDirectory, draft.timezone);
  return activity.sourceFingerprint !== draft.sourceFingerprint;
}

function resultStatus(
  record: NotionPublicationRecord,
  skipped: number,
  sourceChangedAfterApproval: boolean,
): NotionPublicationResult {
  const synced = record.items.filter(({ status }) => status === 'SYNCED').length;
  const failed = record.items.filter(({ status }) => status === 'FAILED').length;
  return {
    status: failed === 0 ? 'SYNCED' : synced === 0 ? 'FAILED' : 'PARTIAL',
    record,
    synced,
    failed,
    skipped,
    sourceChangedAfterApproval,
  };
}

export function notionPublicationPhrase(draftId: string, version: number, previewFingerprint: string): string {
  return `PUBLISH_NOTION:${draftId}:v${version}:${previewFingerprint.slice(0, 12)}`;
}

export class NotionPublicationService implements NotionPublicationPort {
  constructor(
    private readonly dataDirectory: string,
    private readonly notion: NotionPort,
    private readonly drafts = new JsonDraftStore(dataDirectory),
    private readonly events = new JsonEventStore(dataDirectory),
    private readonly publications = new JsonPublicationStore(dataDirectory),
    private readonly clock: Clock = () => new Date(),
  ) {}

  async preview(input: {
    draftId: string;
    version: number;
    selectedNextActionIndexes: number[];
  }): Promise<NotionPublicationPreview> {
    const draftRecords = await this.drafts.read();
    const draft = latestDraft(draftRecords, input.draftId);
    validateApprovedVersion(draft, input.version);
    const selectedNextActionIndexes = normalizeSelection(input.selectedNextActionIndexes, draft.nextActions.length);
    const publicationRecords = await this.publications.read();
    const claim = localWorkLogClaim(draft, draftRecords, publicationRecords);
    const eventMap = new Map((await this.events.read()).map((event) => [event.id, event]));
    const repositoryMap = new Map<string, CreateWorkLogInput['repositories'][number]>();
    for (const item of draft.workItems) {
      const sourceEvents = item.sourceEventIds.map((eventId) => eventMap.get(eventId)).filter((event) => event !== undefined);
      const source = sourceEvents[0];
      const existing = repositoryMap.get(item.repositoryId);
      const repository = existing ?? {
        repositoryId: item.repositoryId,
        name: source?.repositoryName ?? item.repositoryId,
        ...(source?.remoteUrl ? { url: source.remoteUrl } : {}),
        workItems: [],
      };
      repository.workItems.push({
        title: item.title,
        details: item.details,
        verificationStatus: item.verificationStatus,
        sourceEventIds: item.sourceEventIds,
      });
      repositoryMap.set(item.repositoryId, repository);
    }
    const repositories = [...repositoryMap.values()];
    const dailyKey = dailyPublicationKey(draft.workDate, draft.timezone);
    const workLog: WorkLogPreviewItem = {
      kind: 'WORK_LOG',
      sourceIndex: 0,
      localId: dailyWorkLogLocalId(draft.workDate, draft.timezone),
      title: `개발 일지 | ${draft.workDate}`,
      workDate: draft.workDate,
      ...(repositories.length === 1 && repositories[0]?.url ? { repositoryUrl: repositories[0].url } : {}),
      summary: draft.summary,
      repositories,
      draftId: draft.draftId,
      draftVersion: draft.version,
    };
    const tasks: TaskPreviewItem[] = selectedNextActionIndexes.map((sourceIndex) => ({
      kind: 'TASK',
      sourceIndex,
      localId: `${draft.draftId}:v${draft.version}:task:${sourceIndex}`,
      title: draft.nextActions[sourceIndex]!,
      dueDate: draft.workDate,
      status: 'TODO',
      priority: 'MEDIUM',
      draftId: draft.draftId,
      draftVersion: draft.version,
    }));

    let workLogDisposition: WorkLogDisposition = 'CREATE';
    let existingWorkLog: NotionPublicationPreview['existingWorkLog'];
    if (claim.item?.externalId) {
      workLogDisposition = 'SKIP_EXISTING';
      existingWorkLog = {
        localId: claim.item.localId,
        externalId: claim.item.externalId,
        attempts: claim.item.attempts,
        updatedAt: claim.item.updatedAt,
      };
    } else {
      const exactRemote = await this.notion.findWorkLogByLocalId(workLog.localId);
      if (exactRemote) {
        if (!claim.record) conflict(`A Work Log already claims ${draft.workDate} (${draft.timezone}) without matching local draft state`);
        workLogDisposition = 'RECOVER_REMOTE';
      } else {
        const sameDate = await this.notion.findWorkLogsByDate(draft.workDate);
        const conflicts = sameDate.filter(({ localId }) => !localId || !isDailyWorkLogLocalId(localId));
        if (conflicts.length > 0) {
          conflict(`A legacy or unrecognized Work Log already exists for ${draft.workDate}; no page was changed`);
        }
      }
    }

    const sourceChangedAfterApproval = await sourceChanged(draft, this.dataDirectory);
    const previewValue = {
      draftId: draft.draftId,
      draftVersion: draft.version,
      workDate: draft.workDate,
      timezone: draft.timezone,
      dailyKey,
      selectedNextActionIndexes,
      workLogs: [workLog],
      tasks,
      workLogDisposition,
      ...(existingWorkLog ? { existingWorkLog } : {}),
      sourceChangedAfterApproval,
    };
    const previewFingerprint = fingerprint({
      draftId: previewValue.draftId,
      draftVersion: previewValue.draftVersion,
      workDate: previewValue.workDate,
      timezone: previewValue.timezone,
      dailyKey: previewValue.dailyKey,
      selectedNextActionIndexes: previewValue.selectedNextActionIndexes,
      workLogs: previewValue.workLogs,
      tasks: previewValue.tasks,
      sourceChangedAfterApproval: previewValue.sourceChangedAfterApproval,
    });
    return {
      ...previewValue,
      previewFingerprint,
      confirmationPhrase: notionPublicationPhrase(draft.draftId, draft.version, previewFingerprint),
      notion: await this.notion.validateConnection(),
    };
  }

  async publish(input: {
    draftId: string;
    version: number;
    selectedNextActionIndexes: number[];
    previewFingerprint: string;
    publicationAuthorized: boolean;
  }): Promise<NotionPublicationResult> {
    if (!input.publicationAuthorized) {
      throw new PublicationError('PUBLICATION_NOT_AUTHORIZED', 'Notion publication requires explicit user confirmation');
    }
    const preview = await this.preview(input);
    if (preview.previewFingerprint !== input.previewFingerprint) {
      throw new PublicationError('PREVIEW_MISMATCH', 'Publication preview changed; preview and confirm it again');
    }
    if (!preview.notion.valid) {
      throw new PublicationError('NOTION_SCHEMA_INVALID', 'Notion schema does not match the required properties');
    }

    return withFileLock(join(this.dataDirectory, 'notion-publication-run.lock'), async () => {
      const adoptedWorkLog: PublicationItemState | undefined = preview.existingWorkLog ? {
        localId: preview.existingWorkLog.localId,
        kind: 'WORK_LOG',
        sourceIndex: 0,
        status: 'SYNCED',
        attempts: preview.existingWorkLog.attempts,
        externalId: preview.existingWorkLog.externalId,
        updatedAt: preview.existingWorkLog.updatedAt,
      } : undefined;
      let record = await this.publications.initialize({
        draftId: preview.draftId,
        draftVersion: preview.draftVersion,
        workDate: preview.workDate,
        timezone: preview.timezone,
        dailyKey: preview.dailyKey,
        selectedNextActionIndexes: preview.selectedNextActionIndexes,
        previewFingerprint: preview.previewFingerprint,
        items: [
          ...preview.workLogs.map(({ localId, kind, sourceIndex }) => ({ localId, kind, sourceIndex })),
          ...preview.tasks.map(({ localId, kind, sourceIndex }) => ({ localId, kind, sourceIndex })),
        ],
        ...(adoptedWorkLog ? { adoptedWorkLog } : {}),
        timestamp: this.clock().toISOString(),
      });
      let skipped = 0;
      const items: Array<WorkLogPreviewItem | TaskPreviewItem> = [...preview.workLogs, ...preview.tasks];
      for (const item of items) {
        const state = record.items.find(({ localId }) => localId === item.localId);
        if (state?.status === 'SYNCED') {
          skipped += 1;
          continue;
        }
        try {
          let externalId: string | undefined;
          if (item.kind === 'WORK_LOG') {
            externalId = await this.notion.findWorkLogByLocalId(item.localId);
            externalId ??= await this.notion.createWorkLog(item);
          } else {
            externalId = await this.notion.findTaskByLocalId(item.localId);
            externalId ??= await this.notion.createTask(item);
          }
          record = await this.publications.markItem({
            draftId: preview.draftId,
            draftVersion: preview.draftVersion,
            localId: item.localId,
            status: 'SYNCED',
            externalId,
            timestamp: this.clock().toISOString(),
          });
        } catch (error) {
          const errorCode = error instanceof NotionAdapterError ? error.code : 'NOTION_API_ERROR';
          record = await this.publications.markItem({
            draftId: preview.draftId,
            draftVersion: preview.draftVersion,
            localId: item.localId,
            status: 'FAILED',
            errorCode,
            timestamp: this.clock().toISOString(),
          });
        }
      }
      return resultStatus(record, skipped, preview.sourceChangedAfterApproval);
    });
  }

  async getStatus(draftId: string, version: number): Promise<NotionPublicationStatus> {
    const record = await this.publications.get(draftId, version);
    const draftRecords = await this.drafts.read();
    const draftRecord = draftRecords.find((candidate) => candidate.draftId === draftId);
    if (!draftRecord) return { status: 'NOT_STARTED' };
    const draft = draftRecord.revisions[draftRecord.revisions.length - 1]!;
    const changed = await sourceChanged(draft, this.dataDirectory);
    try {
      localWorkLogClaim(draft, draftRecords, await this.publications.read());
    } catch (error) {
      if (error instanceof PublicationError && error.code === 'DAILY_PUBLICATION_CONFLICT') {
        return { status: 'CONFLICT', message: error.message, sourceChangedAfterApproval: changed };
      }
      throw error;
    }
    if (!record) return { status: 'NOT_STARTED' };
    return resultStatus(record, 0, changed);
  }
}
