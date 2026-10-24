import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

const NotionEnvironmentSchema = z.object({
  NOTION_TOKEN: z.string().min(1),
  NOTION_TASKS_DATABASE_ID: z.string().min(1).optional(),
  NOTION_TASKS_DATA_SOURCE_ID: z.string().min(1).optional(),
  NOTION_WORKLOGS_DATABASE_ID: z.string().min(1).optional(),
  NOTION_WORKLOGS_DATA_SOURCE_ID: z.string().min(1).optional(),
}).superRefine((value, context) => {
  if (!value.NOTION_TASKS_DATABASE_ID && !value.NOTION_TASKS_DATA_SOURCE_ID) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Tasks Database ID or Data Source ID is required' });
  }
  if (!value.NOTION_WORKLOGS_DATABASE_ID && !value.NOTION_WORKLOGS_DATA_SOURCE_ID) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Work Logs Database ID or Data Source ID is required' });
  }
});

export type NotionEnvironment = {
  token: string;
  tasks: { databaseId?: string; dataSourceId?: string };
  workLogs: { databaseId?: string; dataSourceId?: string };
};

function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]!] = value;
  }
  return values;
}

export async function loadNotionEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  envFilePath = resolve('.env'),
): Promise<NotionEnvironment> {
  let fileValues: Record<string, string> = {};
  try {
    fileValues = parseEnvFile(await readFile(envFilePath, 'utf8'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const merged = { ...fileValues };
  for (const key of Object.keys(fileValues).concat([
    'NOTION_TOKEN',
    'NOTION_TASKS_DATABASE_ID',
    'NOTION_TASKS_DATA_SOURCE_ID',
    'NOTION_WORKLOGS_DATABASE_ID',
    'NOTION_WORKLOGS_DATA_SOURCE_ID',
  ])) {
    if (environment[key]) merged[key] = environment[key]!;
  }
  const parsed = NotionEnvironmentSchema.safeParse(merged);
  if (!parsed.success) throw new Error('Notion environment configuration is missing or invalid');
  return {
    token: parsed.data.NOTION_TOKEN,
    tasks: {
      databaseId: parsed.data.NOTION_TASKS_DATABASE_ID,
      dataSourceId: parsed.data.NOTION_TASKS_DATA_SOURCE_ID,
    },
    workLogs: {
      databaseId: parsed.data.NOTION_WORKLOGS_DATABASE_ID,
      dataSourceId: parsed.data.NOTION_WORKLOGS_DATA_SOURCE_ID,
    },
  };
}
