import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { DraftRecordSchema, type DraftRecord } from '../drafts/types.js';
import { type AtomicFileOperations, withFileLock, writeJsonAtomic } from './json-store.js';

const DraftsFileSchema = z.object({
  version: z.literal(1),
  records: z.array(DraftRecordSchema),
});

type DraftsFile = z.infer<typeof DraftsFileSchema>;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export class JsonDraftStore {
  readonly filePath: string;

  constructor(
    dataDirectory: string,
    private readonly operations?: AtomicFileOperations,
  ) {
    this.filePath = join(dataDirectory, 'drafts.json');
  }

  async read(): Promise<DraftRecord[]> {
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
      throw new Error(`Draft store is not valid JSON: ${this.filePath}`);
    }
    const result = DraftsFileSchema.safeParse(parsed);
    if (!result.success) throw new Error(`Draft store has an invalid schema: ${this.filePath}`);
    return result.data.records;
  }

  async update<T>(mutate: (records: DraftRecord[]) => { records: DraftRecord[]; result: T; changed: boolean }): Promise<T> {
    return withFileLock(`${this.filePath}.lock`, async () => {
      const mutation = mutate(await this.read());
      if (mutation.changed) {
        const next: DraftsFile = { version: 1, records: mutation.records };
        await writeJsonAtomic(this.filePath, next, this.operations);
      }
      return mutation.result;
    });
  }
}
