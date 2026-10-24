import { describe, expect, it } from 'vitest';
import { NotionAdapter } from '../src/adapters/notion.js';
import { loadNotionEnvironment } from '../src/config/notion.js';

describe.skipIf(process.env.RUN_NOTION_INTEGRATION !== '1')('Notion read-only integration', () => {
  it('authenticates and validates the configured Data Source schemas without writing', async () => {
    const environment = await loadNotionEnvironment();
    const validation = await new NotionAdapter(environment).validateConnection();
    expect(validation.authenticated).toBe(true);
    expect(validation.tasks.dataSourceId).toBeTruthy();
    expect(validation.workLogs.dataSourceId).toBeTruthy();
    expect(validation.valid).toBe(true);
  });
});

