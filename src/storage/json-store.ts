import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { PushAttemptSchema, type PushAttempt } from '../git/types.js';
import { z } from 'zod';

const EventsFileSchema = z.object({
  version: z.literal(1),
  events: z.array(PushAttemptSchema),
});

type EventsFile = z.infer<typeof EventsFileSchema>;

export type AtomicFileOperations = {
  rename: typeof rename;
};

const defaultAtomicOperations: AtomicFileOperations = { rename };

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function pause(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  operations: AtomicFileOperations = defaultAtomicOperations,
): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await operations.rename(temporaryPath, filePath);
    const directoryHandle = await open(directory, 'r');
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function withFileLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 10_000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for data lock: ${lockPath}`);
      await pause(20);
    }
  }

  try {
    return await task();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

export class JsonEventStore {
  readonly filePath: string;
  private readonly operations: AtomicFileOperations;

  constructor(dataDirectory: string, operations: AtomicFileOperations = defaultAtomicOperations) {
    this.filePath = join(dataDirectory, 'events.json');
    this.operations = operations;
  }

  async read(): Promise<PushAttempt[]> {
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
      throw new Error(`Event store is not valid JSON: ${this.filePath}`);
    }
    const result = EventsFileSchema.safeParse(parsed);
    if (!result.success) throw new Error(`Event store has an invalid schema: ${this.filePath}`);
    return result.data.events;
  }

  async append(attempts: PushAttempt[]): Promise<{ added: number; duplicates: number }> {
    return withFileLock(`${this.filePath}.lock`, async () => {
      const current = await this.read();
      const existingIds = new Set(current.map(({ id }) => id));
      const additions: PushAttempt[] = [];
      for (const attempt of attempts) {
        if (existingIds.has(attempt.id)) continue;
        existingIds.add(attempt.id);
        additions.push(attempt);
      }
      if (additions.length > 0) {
        const next: EventsFile = { version: 1, events: [...current, ...additions] };
        await writeJsonAtomic(this.filePath, next, this.operations);
      }
      return { added: additions.length, duplicates: attempts.length - additions.length };
    });
  }
}
