import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  NotionAdapterError,
  type CreateTaskInput,
  type CreateWorkLogInput,
  type NotionConnectionValidation,
  type NotionPort,
} from '../adapters/notion.js';
import type { DailyDraft } from '../drafts/types.js';
import type { NotionPublicationRecord, PublicationKind } from '../publication/types.js';
import { JsonDraftStore } from '../storage/draft-store.js';
import { JsonEventStore } from '../storage/json-store.js';
import { JsonPublicationStore } from '../storage/publication-store.js';
import { withFileLock } from '../storage/json-store.js';

export type PublicationErrorCode =
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_NOT_APPROVED'
  | 'APPROVED_VERSION_MISMATCH'
  | 'INVALID_SELECTION'
  | 'PREVIEW_MISMATCH'
  | 'PUBLICATION_NOT_AUTHORIZED'
  | 'NOTION_SCHEMA_INVALID'
  | 'PUBLICATION_NOT_FOUND'
  | 'STORAGE_ERROR';

export class PublicationError extends Error {
  constructor(readonly code: PublicationErrorCode, message: string) {
    super(message);
    this.name = 'PublicationError';
  }
}

export type WorkLogPreviewItem = CreateWorkLogInput & { kind: 'WORK_LOG'; sourceIndex: number };
export type TaskPreviewItem = CreateTaskInput & { kind: 'TASK'; sourceIndex: number };

export type NotionPublicationPreview = {
  draftId: string;
  draftVersion: number;
  workDate: string;
  selectedNextActionIndexes: number[];
  workLogs: WorkLogPreviewItem[];
  tasks: TaskPreviewItem[];
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
};

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
  getStatus(draftId: string, version: number): Promise<NotionPublicationResult | { status: 'NOT_STARTED' }>;
}

function latestDraft(records: Awaited<ReturnType<JsonDraftStore['read']>>, draftId: string): DailyDraft {
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

function resultStatus(record: NotionPublicationRecord, skipped: number): NotionPublicationResult {
  const synced = record.items.filter(({ status }) => status === 'SYNCED').length;
  const failed = record.items.filter(({ status }) => status === 'FAILED').length;
  return {
    status: failed === 0 ? 'SYNCED' : synced === 0 ? 'FAILED' : 'PARTIAL',
    record,
    synced,
    failed,
    skipped,
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
    const draft = latestDraft(await this.drafts.read(), input.draftId);
    validateApprovedVersion(draft, input.version);
    const selectedNextActionIndexes = normalizeSelection(input.selectedNextActionIndexes, draft.nextActions.length);
    const events = new Map((await this.events.read()).map((event) => [event.id, event]));
    const workLogs: WorkLogPreviewItem[] = draft.workItems.map((item, sourceIndex) => {
      const source = item.sourceEventIds.map((eventId) => events.get(eventId)).find((event) => event !== undefined);
      return {
        kind: 'WORK_LOG',
        sourceIndex,
        localId: `${draft.draftId}:v${draft.version}:work:${sourceIndex}`,
        title: `${draft.workDate} · ${source?.repositoryName ?? item.repositoryId} · ${item.title}`,
        workDate: draft.workDate,
        ...(source?.remoteUrl ? { repositoryUrl: source.remoteUrl } : {}),
        summary: item.title,
        details: item.details,
        verificationStatus: item.verificationStatus,
        sourceEventIds: item.sourceEventIds,
        draftId: draft.draftId,
        draftVersion: draft.version,
      };
    });
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
    const previewFingerprint = fingerprint({
      draftId: draft.draftId,
      draftVersion: draft.version,
      selectedNextActionIndexes,
      workLogs,
      tasks,
    });
    return {
      draftId: draft.draftId,
      draftVersion: draft.version,
      workDate: draft.workDate,
      selectedNextActionIndexes,
      workLogs,
      tasks,
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
      let record = await this.publications.initialize({
        draftId: preview.draftId,
        draftVersion: preview.draftVersion,
        selectedNextActionIndexes: preview.selectedNextActionIndexes,
        previewFingerprint: preview.previewFingerprint,
        items: [
          ...preview.workLogs.map(({ localId, kind, sourceIndex }) => ({ localId, kind, sourceIndex })),
          ...preview.tasks.map(({ localId, kind, sourceIndex }) => ({ localId, kind, sourceIndex })),
        ],
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
      return resultStatus(record, skipped);
    });
  }

  async getStatus(draftId: string, version: number): Promise<NotionPublicationResult | { status: 'NOT_STARTED' }> {
    const record = await this.publications.get(draftId, version);
    return record ? resultStatus(record, 0) : { status: 'NOT_STARTED' };
  }
}
