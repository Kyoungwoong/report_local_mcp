import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadNotionEnvironment } from '../src/config/notion.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('Notion environment loading', () => {
  it('reads supported values without interpolation and lets process environment override the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-devlog-notion-env-'));
    directories.push(directory);
    const filePath = join(directory, '.env');
    await writeFile(filePath, [
      'NOTION_TOKEN="literal-$VALUE"',
      'NOTION_TASKS_DATABASE_ID=tasks-db',
      'NOTION_WORKLOGS_DATA_SOURCE_ID=logs-ds',
    ].join('\n'));
    const loaded = await loadNotionEnvironment({ NOTION_TOKEN: 'process-token' }, filePath);
    expect(loaded).toEqual({
      token: 'process-token',
      tasks: { databaseId: 'tasks-db', dataSourceId: undefined },
      workLogs: { databaseId: undefined, dataSourceId: 'logs-ds' },
    });
  });

  it('returns a generic configuration error that does not include file contents', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-devlog-notion-env-error-'));
    directories.push(directory);
    const filePath = join(directory, '.env');
    await writeFile(filePath, 'NOTION_TOKEN=sensitive-test-value\n');
    await expect(loadNotionEnvironment({}, filePath)).rejects.toThrow('Notion environment configuration is missing or invalid');
  });
});
