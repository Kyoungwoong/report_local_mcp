import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeJsonAtomic } from '../storage/json-store.js';

export const DEFAULT_TIMEZONE = 'Asia/Seoul';

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

export const RepositoryConfigSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1),
  path: z.string().min(1),
  hookPath: z.string().min(1),
  hookHash: z.string().regex(/^[0-9a-f]{64}$/),
  addedAt: z.string().datetime(),
});

export const CalendarConfigSchema = z.object({
  identifier: z.string().min(1),
  title: z.string().min(1),
  sourceTitle: z.string().min(1),
});

export const AppConfigSchema = z.object({
  version: z.literal(1),
  timezone: z.string().refine(isValidTimeZone, 'Invalid IANA timezone'),
  repositories: z.array(RepositoryConfigSchema),
  calendar: CalendarConfigSchema.optional(),
});

export type RepositoryConfig = z.infer<typeof RepositoryConfigSchema>;
export type CalendarConfig = z.infer<typeof CalendarConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function getDataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.LOCAL_DEVLOG_DATA_DIR) return resolve(environment.LOCAL_DEVLOG_DATA_DIR);
  return join(homedir(), 'Library', 'Application Support', 'local-devlog-mcp');
}

export function createDefaultConfig(): AppConfig {
  return { version: 1, timezone: DEFAULT_TIMEZONE, repositories: [] };
}

export async function loadConfig(dataDirectory = getDataDirectory()): Promise<AppConfig> {
  const configPath = join(dataDirectory, 'config.json');
  let contents: string;
  try {
    contents = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return createDefaultConfig();
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Configuration is not valid JSON: ${configPath}`);
  }
  const result = AppConfigSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Configuration has an invalid schema: ${configPath}`);
  return result.data;
}

export async function saveConfig(config: AppConfig, dataDirectory = getDataDirectory()): Promise<void> {
  const validated = AppConfigSchema.parse(config);
  await writeJsonAtomic(join(dataDirectory, 'config.json'), validated);
}
