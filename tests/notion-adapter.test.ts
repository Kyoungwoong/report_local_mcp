import type { CreatePageParameters } from '@notionhq/client';
import { describe, expect, it } from 'vitest';
import {
  NotionAdapter,
  NotionAdapterError,
  withNotionRetry,
  type NotionApi,
  type NotionPropertySummary,
} from '../src/adapters/notion.js';
import type { NotionEnvironment } from '../src/config/notion.js';

const environment: NotionEnvironment = {
  token: 'test-token-not-real',
  tasks: { databaseId: 'tasks-data-source' },
  workLogs: { databaseId: 'logs-data-source' },
};

const tasksProperties: Record<string, NotionPropertySummary> = {
  Name: { id: 'title', type: 'title' },
  'Due Date': { id: 'due', type: 'date' },
  'Local Id': { id: 'local', type: 'rich_text' },
  Status: { id: 'status', type: 'select', options: ['TODO', 'DONE'] },
  Priority: { id: 'priority', type: 'select', options: ['MEDIUM'] },
};

const workLogProperties: Record<string, NotionPropertySummary> = {
  Name: { id: 'title', type: 'title' },
  Date: { id: 'date', type: 'date' },
  Repository: { id: 'repository', type: 'url' },
  Summary: { id: 'summary', type: 'rich_text' },
  'Local ID': { id: 'local', type: 'rich_text' },
};

class FakeApi implements NotionApi {
  readonly created: CreatePageParameters[] = [];
  queryResult: string[] = [];
  authError?: Error;
  missing = new Set<string>();
  taskProperties = tasksProperties;

  async getSelf(): Promise<{ name: string | null }> {
    if (this.authError) throw this.authError;
    return { name: 'report-mcp' };
  }

  async retrieveDatabase(databaseId: string): Promise<{ id: string; dataSources: Array<{ id: string; name: string }> }> {
    if (this.missing.has(databaseId) || databaseId.endsWith('data-source')) {
      throw new NotionAdapterError('OBJECT_NOT_FOUND', 'not found');
    }
    return { id: databaseId, dataSources: [] };
  }

  async retrieveDataSource(dataSourceId: string) {
    if (this.missing.has(dataSourceId)) throw new NotionAdapterError('OBJECT_NOT_FOUND', 'not found');
    if (dataSourceId === 'tasks-data-source') {
      return { id: dataSourceId, title: 'Tasks', parentDatabaseId: 'tasks-database', properties: this.taskProperties };
    }
    return { id: dataSourceId, title: 'Work Logs', parentDatabaseId: 'logs-database', properties: workLogProperties };
  }

  async queryDataSource(): Promise<string[]> {
    return this.queryResult;
  }

  async createPage(parameters: CreatePageParameters): Promise<string> {
    this.created.push(parameters);
    return `page-${this.created.length}`;
  }
}

describe('Notion adapter', () => {
  it('retries 429-style retryable failures without exposing request details', async () => {
    let attempts = 0;
    const delays: number[] = [];
    const result = await withNotionRetry(async () => {
      attempts += 1;
      if (attempts < 3) throw new NotionAdapterError('RATE_LIMITED', 'rate limited', true);
      return 'ok';
    }, async (milliseconds) => { delays.push(milliseconds); });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it('reports authentication failure without exposing the configured token', async () => {
    const api = new FakeApi();
    api.authError = new NotionAdapterError('AUTHENTICATION_FAILED', 'Notion authentication failed');
    const error = await new NotionAdapter(environment, api).validateConnection().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(String(error)).not.toContain(environment.token);
  });

  it('reports an invalid Database or Data Source ID', async () => {
    const api = new FakeApi();
    api.missing.add('tasks-data-source');
    await expect(new NotionAdapter(environment, api).validateConnection()).rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' });
  });

  it('detects property type and required select option mismatches without modifying schema', async () => {
    const api = new FakeApi();
    api.taskProperties = {
      ...tasksProperties,
      'Due Date': { id: 'due', type: 'rich_text' },
      Status: { id: 'status', type: 'select', options: ['DONE'] },
    };
    const validation = await new NotionAdapter(environment, api).validateConnection();
    expect(validation.valid).toBe(false);
    expect(validation.tasks.mismatches).toEqual(expect.arrayContaining([
      { property: 'Due Date', expected: 'date', actual: 'rich_text' },
      { property: 'Status', expected: 'select option TODO', actual: 'select' },
    ]));
    expect(api.created).toHaveLength(0);
  });

  it('resolves legacy Data Source IDs stored in Database variables and supports lookup and creation', async () => {
    const api = new FakeApi();
    const adapter = new NotionAdapter(environment, api);
    const validation = await adapter.validateConnection();
    expect(validation).toMatchObject({ authenticated: true, valid: true, botName: 'report-mcp' });
    expect(validation.tasks).toMatchObject({
      databaseId: 'tasks-database',
      dataSourceId: 'tasks-data-source',
      valid: true,
    });
    expect(validation.tasks.warnings[0]).toContain('*_DATABASE_ID setting contains a Data Source ID');

    api.queryResult = ['existing-page'];
    await expect(adapter.findTaskByLocalId('local-task')).resolves.toBe('existing-page');
    api.queryResult = [];
    await expect(adapter.createTask({
      localId: 'local-task', title: 'Task', dueDate: '2026-10-24', status: 'TODO', priority: 'MEDIUM',
      draftId: '11111111-1111-4111-8111-111111111111', draftVersion: 1,
    })).resolves.toBe('page-1');
    await expect(adapter.createWorkLog({
      localId: 'local-log', title: 'Log', workDate: '2026-10-24', repositoryUrl: 'https://example.invalid/repo.git',
      summary: 'Summary', details: 'Detailed work', verificationStatus: 'UNCONFIRMED', sourceEventIds: ['a'.repeat(64)],
      draftId: '11111111-1111-4111-8111-111111111111', draftVersion: 1,
    })).resolves.toBe('page-2');
    expect(api.created[1]).toMatchObject({ markdown: expect.stringContaining('Detailed work') });
  });
});
