import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  CalendarPublicationRecordSchema,
  type CalendarPublicationRecord,
} from '../publication/calendar-types.js';
import { type AtomicFileOperations, withFileLock, writeJsonAtomic } from './json-store.js';

const CalendarPublicationsFileSchema = z.object({
  version: z.literal(1),
  records: z.array(CalendarPublicationRecordSchema),
});

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class JsonCalendarPublicationStore {
  readonly filePath: string;

  constructor(dataDirectory: string, private readonly operations?: AtomicFileOperations) {
    this.filePath = join(dataDirectory, 'calendar-publications.json');
  }

  async read(): Promise<CalendarPublicationRecord[]> {
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
      throw new Error(`Calendar publication store is not valid JSON: ${this.filePath}`);
    }
    const result = CalendarPublicationsFileSchema.safeParse(parsed);
    if (!result.success) throw new Error(`Calendar publication store has an invalid schema: ${this.filePath}`);
    return result.data.records;
  }

  private async update<T>(mutate: (records: CalendarPublicationRecord[]) => {
    records: CalendarPublicationRecord[];
    result: T;
  }): Promise<T> {
    return withFileLock(`${this.filePath}.lock`, async () => {
      const mutation = mutate(await this.read());
      await writeJsonAtomic(this.filePath, { version: 1, records: mutation.records }, this.operations);
      return mutation.result;
    });
  }

  async initialize(input: {
    draftId: string;
    draftVersion: number;
    localId: string;
    previewFingerprint: string;
    calendarIdentifier: string;
    workDate: string;
    timestamp: string;
  }): Promise<CalendarPublicationRecord> {
    return this.update((records) => {
      const index = records.findIndex(({ draftId, draftVersion }) =>
        draftId === input.draftId && draftVersion === input.draftVersion);
      const existing = index >= 0 ? records[index] : undefined;
      const record: CalendarPublicationRecord = {
        draftId: input.draftId,
        draftVersion: input.draftVersion,
        localId: input.localId,
        previewFingerprint: input.previewFingerprint,
        calendarIdentifier: input.calendarIdentifier,
        workDate: input.workDate,
        status: existing?.status ?? 'PENDING',
        attempts: existing?.attempts ?? 0,
        ...(existing?.eventIdentifier ? { eventIdentifier: existing.eventIdentifier } : {}),
        ...(existing?.errorCode ? { errorCode: existing.errorCode } : {}),
        createdAt: existing?.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
      };
      const next = [...records];
      if (index >= 0) next[index] = record;
      else next.push(record);
      return { records: next, result: record };
    });
  }

  async mark(input: {
    draftId: string;
    draftVersion: number;
    status: 'SYNCED' | 'FAILED';
    eventIdentifier?: string;
    errorCode?: string;
    timestamp: string;
  }): Promise<CalendarPublicationRecord> {
    return this.update((records) => {
      const index = records.findIndex(({ draftId, draftVersion }) =>
        draftId === input.draftId && draftVersion === input.draftVersion);
      if (index < 0) throw new Error('Calendar publication record not found');
      const current = records[index]!;
      const record: CalendarPublicationRecord = {
        ...current,
        status: input.status,
        attempts: current.attempts + 1,
        ...(input.eventIdentifier ? { eventIdentifier: input.eventIdentifier } : {}),
        updatedAt: input.timestamp,
      };
      if (input.errorCode) record.errorCode = input.errorCode;
      else delete record.errorCode;
      const next = [...records];
      next[index] = record;
      return { records: next, result: record };
    });
  }

  async get(draftId: string, draftVersion: number): Promise<CalendarPublicationRecord | undefined> {
    return (await this.read()).find((record) =>
      record.draftId === draftId && record.draftVersion === draftVersion);
  }
}
