import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  NotionPublicationRecordSchema,
  type NotionPublicationRecord,
  type PublicationKind,
} from '../publication/types.js';
import { type AtomicFileOperations, withFileLock, writeJsonAtomic } from './json-store.js';

const PublicationsFileSchema = z.object({
  version: z.literal(1),
  records: z.array(NotionPublicationRecordSchema),
});

type PublicationsFile = z.infer<typeof PublicationsFileSchema>;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class JsonPublicationStore {
  readonly filePath: string;

  constructor(
    dataDirectory: string,
    private readonly operations?: AtomicFileOperations,
  ) {
    this.filePath = join(dataDirectory, 'notion-publications.json');
  }

  async read(): Promise<NotionPublicationRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      throw new Error(`Notion publication store is not valid JSON: ${this.filePath}`);
    }
    const result = PublicationsFileSchema.safeParse(parsed);
    if (!result.success) throw new Error(`Notion publication store has an invalid schema: ${this.filePath}`);
    return result.data.records;
  }

  private async update<T>(mutate: (records: NotionPublicationRecord[]) => { records: NotionPublicationRecord[]; result: T }): Promise<T> {
    return withFileLock(`${this.filePath}.lock`, async () => {
      const mutation = mutate(await this.read());
      const next: PublicationsFile = { version: 1, records: mutation.records };
      await writeJsonAtomic(this.filePath, next, this.operations);
      return mutation.result;
    });
  }

  async initialize(input: {
    draftId: string;
    draftVersion: number;
    workDate: string;
    timezone: string;
    dailyKey: string;
    selectedNextActionIndexes: number[];
    previewFingerprint: string;
    items: Array<{ localId: string; kind: PublicationKind; sourceIndex: number }>;
    adoptedWorkLog?: NotionPublicationRecord['items'][number];
    timestamp: string;
  }): Promise<NotionPublicationRecord> {
    return this.update((records) => {
      const index = records.findIndex(({ draftId, draftVersion }) =>
        draftId === input.draftId && draftVersion === input.draftVersion);
      const existing = index >= 0 ? records[index] : undefined;
      const existingItems = new Map(existing?.items.map((item) => [item.localId, item]));
      const requestedItems = input.items.map((item) => {
        const current = existingItems.get(item.localId);
        if (current) return current;
        if (item.kind === 'WORK_LOG' && input.adoptedWorkLog) {
          return {
            ...item,
            status: input.adoptedWorkLog.status,
            attempts: input.adoptedWorkLog.attempts,
            ...(input.adoptedWorkLog.externalId ? { externalId: input.adoptedWorkLog.externalId } : {}),
            ...(input.adoptedWorkLog.errorCode ? { errorCode: input.adoptedWorkLog.errorCode } : {}),
            updatedAt: input.timestamp,
          };
        }
        return {
          ...item,
          status: 'PENDING' as const,
          attempts: 0,
          updatedAt: input.timestamp,
        };
      });
      const requestedIds = new Set(requestedItems.map(({ localId }) => localId));
      const replacesWorkLog = input.items.some(({ kind }) => kind === 'WORK_LOG');
      const items = [
        ...(existing?.items.filter(({ localId, kind }) =>
          !requestedIds.has(localId) && !(replacesWorkLog && kind === 'WORK_LOG')) ?? []),
        ...requestedItems,
      ];
      const record: NotionPublicationRecord = {
        draftId: input.draftId,
        draftVersion: input.draftVersion,
        workDate: input.workDate,
        timezone: input.timezone,
        dailyKey: input.dailyKey,
        selectedNextActionIndexes: [...new Set([
          ...(existing?.selectedNextActionIndexes ?? []),
          ...input.selectedNextActionIndexes,
        ])].sort((left, right) => left - right),
        lastPreviewFingerprint: input.previewFingerprint,
        items,
        createdAt: existing?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
      };
      const nextRecords = [...records];
      if (index >= 0) nextRecords[index] = record;
      else nextRecords.push(record);
      return { records: nextRecords, result: record };
    });
  }

  async markItem(input: {
    draftId: string;
    draftVersion: number;
    localId: string;
    status: 'SYNCED' | 'FAILED';
    externalId?: string;
    errorCode?: string;
    timestamp: string;
  }): Promise<NotionPublicationRecord> {
    return this.update((records) => {
      const recordIndex = records.findIndex(({ draftId, draftVersion }) =>
        draftId === input.draftId && draftVersion === input.draftVersion);
      if (recordIndex < 0) throw new Error('Publication record not found');
      const record = records[recordIndex]!;
      const itemIndex = record.items.findIndex(({ localId }) => localId === input.localId);
      if (itemIndex < 0) throw new Error('Publication item not found');
      const items = [...record.items];
      items[itemIndex] = {
        ...items[itemIndex]!,
        status: input.status,
        attempts: items[itemIndex]!.attempts + 1,
        ...(input.externalId ? { externalId: input.externalId } : {}),
        ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        updatedAt: input.timestamp,
      };
      if (!input.errorCode) delete items[itemIndex]!.errorCode;
      const updated = { ...record, items, updatedAt: input.timestamp };
      const nextRecords = [...records];
      nextRecords[recordIndex] = updated;
      return { records: nextRecords, result: updated };
    });
  }

  async get(draftId: string, draftVersion: number): Promise<NotionPublicationRecord | undefined> {
    return (await this.read()).find((record) => record.draftId === draftId && record.draftVersion === draftVersion);
  }
}
