import {
  APIErrorCode,
  Client,
  LogLevel,
  isNotionClientError,
  type CreatePageParameters,
} from '@notionhq/client';
import type { NotionEnvironment } from '../config/notion.js';

export const NOTION_API_VERSION = '2026-03-11';

export type NotionAdapterErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'OBJECT_NOT_FOUND'
  | 'SCHEMA_MISMATCH'
  | 'RATE_LIMITED'
  | 'NOTION_API_ERROR'
  | 'NOTION_CONFIG_ERROR';

export class NotionAdapterError extends Error {
  constructor(
    readonly code: NotionAdapterErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'NotionAdapterError';
  }
}

export interface NotionApi {
  getSelf(): Promise<{ name: string | null }>;
  retrieveDatabase(databaseId: string): Promise<{
    id: string;
    dataSources: Array<{ id: string; name: string }>;
  }>;
  retrieveDataSource(dataSourceId: string): Promise<{
    id: string;
    title: string;
    parentDatabaseId?: string;
    properties: Record<string, NotionPropertySummary>;
  }>;
  queryDataSource(dataSourceId: string, propertyName: string, localId: string): Promise<string[]>;
  queryWorkLogsByDate(dataSourceId: string, workDate: string): Promise<Array<{ id: string; localId?: string }>>;
  createPage(parameters: CreatePageParameters): Promise<string>;
}

type Sleep = (milliseconds: number) => Promise<void>;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeSdkError(error: unknown): NotionAdapterError {
  if (error instanceof NotionAdapterError) return error;
  if (!isNotionClientError(error)) return new NotionAdapterError('NOTION_API_ERROR', 'Notion request failed');
  if (error.code === APIErrorCode.Unauthorized || error.code === APIErrorCode.RestrictedResource) {
    return new NotionAdapterError('AUTHENTICATION_FAILED', 'Notion authentication or access permission failed');
  }
  if (error.code === APIErrorCode.ObjectNotFound) {
    return new NotionAdapterError('OBJECT_NOT_FOUND', 'The requested Notion object was not found or is not shared with the integration');
  }
  if (error.code === APIErrorCode.RateLimited) {
    return new NotionAdapterError('RATE_LIMITED', 'Notion rate limit was exceeded', true);
  }
  const retryable = error.code === APIErrorCode.ServiceUnavailable
    || error.code === APIErrorCode.ServiceOverload
    || error.code === APIErrorCode.InternalServerError
    || error.code === APIErrorCode.GatewayTimeout;
  return new NotionAdapterError('NOTION_API_ERROR', 'Notion API returned an error', retryable);
}

function rateLimitDelay(error: unknown, attempt: number): number {
  if (error instanceof Error && 'headers' in error) {
    const headers = error.headers;
    let value: string | null | undefined;
    if (headers instanceof Headers) value = headers.get('retry-after');
    else if (typeof headers === 'object' && headers !== null) {
      const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'retry-after');
      if (typeof entry?.[1] === 'string') value = entry[1];
    }
    if (value) {
      const seconds = Number(value);
      const milliseconds = Number.isFinite(seconds)
        ? seconds * 1_000
        : new Date(value).getTime() - Date.now();
      if (Number.isFinite(milliseconds) && milliseconds > 0) return Math.min(milliseconds, 60_000);
    }
  }
  return Math.min(250 * (2 ** (attempt - 1)), 2_000);
}

export async function withNotionRetry<T>(
  operation: () => Promise<T>,
  sleep: Sleep = delay,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const safe = safeSdkError(error);
      if (!safe.retryable || attempt === maxAttempts) throw safe;
      await sleep(rateLimitDelay(error, attempt));
    }
  }
  throw new NotionAdapterError('NOTION_API_ERROR', 'Notion request failed');
}

export class SdkNotionApi implements NotionApi {
  private readonly client: Client;

  constructor(
    token: string,
    private readonly sleep: Sleep = delay,
    private readonly maxAttempts = 3,
  ) {
    this.client = new Client({
      auth: token,
      notionVersion: NOTION_API_VERSION,
      retry: false,
      timeoutMs: 15_000,
      logLevel: LogLevel.ERROR,
      logger: (level, message) => {
        process.stderr.write(`[notion] ${level}: ${message}\n`);
      },
    });
  }

  private async request<T>(operation: () => Promise<T>): Promise<T> {
    return withNotionRetry(operation, this.sleep, this.maxAttempts);
  }

  async getSelf(): Promise<{ name: string | null }> {
    const response = await this.request(() => this.client.users.me({}));
    return { name: response.name };
  }

  async retrieveDatabase(databaseId: string): Promise<{ id: string; dataSources: Array<{ id: string; name: string }> }> {
    const response = await this.request(() => this.client.databases.retrieve({ database_id: databaseId }));
    if (!('data_sources' in response)) throw new NotionAdapterError('NOTION_API_ERROR', 'Notion Database response was incomplete');
    return { id: response.id, dataSources: response.data_sources };
  }

  async retrieveDataSource(dataSourceId: string): Promise<{
    id: string;
    title: string;
    parentDatabaseId?: string;
    properties: Record<string, NotionPropertySummary>;
  }> {
    const response = await this.request(() => this.client.dataSources.retrieve({ data_source_id: dataSourceId }));
    const properties: Record<string, NotionPropertySummary> = {};
    for (const [name, property] of Object.entries(response.properties)) {
      const options = property.type === 'select' ? property.select.options.map((option) => option.name) : undefined;
      properties[name] = { id: property.id, type: property.type, ...(options ? { options } : {}) };
    }
    return {
      id: response.id,
      title: 'title' in response ? response.title.map(({ plain_text }) => plain_text).join('') : '',
      ...('parent' in response && response.parent.type === 'database_id'
        ? { parentDatabaseId: response.parent.database_id }
        : {}),
      properties,
    };
  }

  async queryDataSource(dataSourceId: string, propertyName: string, localId: string): Promise<string[]> {
    const response = await this.request(() => this.client.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 2,
      result_type: 'page',
      filter: { property: propertyName, rich_text: { equals: localId } },
    }));
    return response.results.filter(({ object }) => object === 'page').map(({ id }) => id);
  }

  async queryWorkLogsByDate(dataSourceId: string, workDate: string): Promise<Array<{ id: string; localId?: string }>> {
    const response = await this.request(() => this.client.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 100,
      result_type: 'page',
      filter: { property: 'Date', date: { equals: workDate } },
    }));
    return response.results.filter(({ object }) => object === 'page').map((page) => {
      if (!('properties' in page)) return { id: page.id };
      const property = page.properties['Local ID'];
      if (!property || property.type !== 'rich_text') return { id: page.id };
      const localId = property.rich_text.map(({ plain_text }) => plain_text).join('');
      return { id: page.id, ...(localId ? { localId } : {}) };
    });
  }

  async createPage(parameters: CreatePageParameters): Promise<string> {
    return (await this.request(() => this.client.pages.create(parameters))).id;
  }
}

export type NotionPropertySummary = {
  id: string;
  type: string;
  options?: string[];
};

export type NotionSchemaMismatch = {
  property: string;
  expected: string;
  actual: string | null;
};

export type ResolvedNotionTarget = {
  label: 'Tasks' | 'Work Logs';
  databaseId: string;
  dataSourceId: string;
  title: string;
  properties: Record<string, NotionPropertySummary>;
  mismatches: NotionSchemaMismatch[];
  warnings: string[];
  valid: boolean;
};

export type NotionConnectionValidation = {
  authenticated: true;
  botName: string | null;
  apiVersion: string;
  valid: boolean;
  tasks: ResolvedNotionTarget;
  workLogs: ResolvedNotionTarget;
};

export type CreateTaskInput = {
  localId: string;
  title: string;
  dueDate: string;
  status: 'TODO';
  priority: 'MEDIUM';
  draftId: string;
  draftVersion: number;
};

export type CreateWorkLogInput = {
  localId: string;
  title: string;
  workDate: string;
  repositoryUrl?: string;
  summary: string;
  repositories: Array<{
    repositoryId: string;
    name: string;
    url?: string;
    workItems: Array<{
      title: string;
      details: string;
      verificationStatus: 'REMOTE_MATCH' | 'UNCONFIRMED';
      sourceEventIds: string[];
    }>;
  }>;
  draftId: string;
  draftVersion: number;
};

export type RemoteWorkLog = { id: string; localId?: string };

export interface NotionPort {
  validateConnection(): Promise<NotionConnectionValidation>;
  findTaskByLocalId(localId: string): Promise<string | undefined>;
  createTask(input: CreateTaskInput): Promise<string>;
  findWorkLogByLocalId(localId: string): Promise<string | undefined>;
  findWorkLogsByDate(workDate: string): Promise<RemoteWorkLog[]>;
  createWorkLog(input: CreateWorkLogInput): Promise<string>;
}

type TargetRequirement = {
  type: string;
  option?: string;
};

const TASK_REQUIREMENTS: Record<string, TargetRequirement> = {
  Name: { type: 'title' },
  'Due Date': { type: 'date' },
  'Local Id': { type: 'rich_text' },
  Status: { type: 'select', option: 'TODO' },
  Priority: { type: 'select', option: 'MEDIUM' },
};

const WORK_LOG_REQUIREMENTS: Record<string, TargetRequirement> = {
  Name: { type: 'title' },
  Date: { type: 'date' },
  Repository: { type: 'url' },
  Summary: { type: 'rich_text' },
  'Local ID': { type: 'rich_text' },
};

function compareSchema(
  properties: Record<string, NotionPropertySummary>,
  requirements: Record<string, TargetRequirement>,
): NotionSchemaMismatch[] {
  const mismatches: NotionSchemaMismatch[] = [];
  for (const [name, requirement] of Object.entries(requirements)) {
    const actual = properties[name];
    if (!actual || actual.type !== requirement.type) {
      mismatches.push({ property: name, expected: requirement.type, actual: actual?.type ?? null });
      continue;
    }
    if (requirement.option && !actual.options?.includes(requirement.option)) {
      mismatches.push({ property: name, expected: `${requirement.type} option ${requirement.option}`, actual: requirement.type });
    }
  }
  return mismatches;
}

function richText(content: string) {
  return [{ type: 'text' as const, text: { content: content.slice(0, 1_900) } }];
}

export class NotionAdapter implements NotionPort {
  private validation?: NotionConnectionValidation;

  constructor(
    private readonly environment: NotionEnvironment,
    private readonly api: NotionApi = new SdkNotionApi(environment.token),
  ) {}

  private async resolveTarget(
    label: 'Tasks' | 'Work Logs',
    configured: { databaseId?: string; dataSourceId?: string },
    requirements: Record<string, TargetRequirement>,
  ): Promise<ResolvedNotionTarget> {
    const warnings: string[] = [];
    let databaseId = configured.databaseId;
    let dataSourceId = configured.dataSourceId;

    if (!dataSourceId && databaseId) {
      try {
        const database = await this.api.retrieveDatabase(databaseId);
        const matching = database.dataSources.find(({ name }) => name === label);
        const selected = matching ?? (database.dataSources.length === 1 ? database.dataSources[0] : undefined);
        if (!selected) throw new NotionAdapterError('NOTION_CONFIG_ERROR', `${label} Database does not identify one usable Data Source`);
        dataSourceId = selected.id;
      } catch (error) {
        const safe = safeSdkError(error);
        if (safe.code !== 'OBJECT_NOT_FOUND') throw safe;
        const dataSource = await this.api.retrieveDataSource(databaseId);
        if (!dataSource.parentDatabaseId) throw safe;
        dataSourceId = dataSource.id;
        databaseId = dataSource.parentDatabaseId;
        warnings.push(`${label}: the *_DATABASE_ID setting contains a Data Source ID; add the explicit Database and Data Source settings when convenient`);
      }
    }
    if (!dataSourceId) throw new NotionAdapterError('NOTION_CONFIG_ERROR', `${label} Data Source ID is missing`);

    const dataSource = await this.api.retrieveDataSource(dataSourceId);
    if (!dataSource.parentDatabaseId) {
      throw new NotionAdapterError('NOTION_CONFIG_ERROR', `${label} Data Source is not attached to a Database`);
    }
    const parentDatabaseId = dataSource.parentDatabaseId;
    if (databaseId && databaseId !== parentDatabaseId && configured.dataSourceId) {
      throw new NotionAdapterError('NOTION_CONFIG_ERROR', `${label} Database ID does not match the Data Source parent`);
    }
    databaseId = parentDatabaseId;
    await this.api.retrieveDatabase(databaseId);

    const properties = dataSource.properties;
    const mismatches = compareSchema(properties, requirements);
    return {
      label,
      databaseId,
      dataSourceId,
      title: dataSource.title || label,
      properties,
      mismatches,
      warnings,
      valid: mismatches.length === 0,
    };
  }

  async validateConnection(): Promise<NotionConnectionValidation> {
    const self = await this.api.getSelf().catch((error) => { throw safeSdkError(error); });
    const tasks = await this.resolveTarget('Tasks', this.environment.tasks, TASK_REQUIREMENTS);
    const workLogs = await this.resolveTarget('Work Logs', this.environment.workLogs, WORK_LOG_REQUIREMENTS);
    const result: NotionConnectionValidation = {
      authenticated: true,
      botName: self.name,
      apiVersion: NOTION_API_VERSION,
      valid: tasks.valid && workLogs.valid,
      tasks,
      workLogs,
    };
    this.validation = result;
    return result;
  }

  private async targets(): Promise<NotionConnectionValidation> {
    const validation = this.validation ?? await this.validateConnection();
    if (!validation.valid) throw new NotionAdapterError('SCHEMA_MISMATCH', 'Notion Data Source schema does not match the required properties');
    return validation;
  }

  async findTaskByLocalId(localId: string): Promise<string | undefined> {
    const targets = await this.targets();
    return (await this.api.queryDataSource(targets.tasks.dataSourceId, 'Local Id', localId))[0];
  }

  async createTask(input: CreateTaskInput): Promise<string> {
    const targets = await this.targets();
    return this.api.createPage({
      parent: { type: 'data_source_id', data_source_id: targets.tasks.dataSourceId },
      properties: {
        Name: { type: 'title', title: richText(input.title) },
        'Due Date': { type: 'date', date: { start: input.dueDate } },
        'Local Id': { type: 'rich_text', rich_text: richText(input.localId) },
        Status: { type: 'select', select: { name: input.status } },
        Priority: { type: 'select', select: { name: input.priority } },
      },
      markdown: `Created from approved Local DevLog draft ${input.draftId} version ${input.draftVersion}.`,
    });
  }

  async findWorkLogByLocalId(localId: string): Promise<string | undefined> {
    const targets = await this.targets();
    return (await this.api.queryDataSource(targets.workLogs.dataSourceId, 'Local ID', localId))[0];
  }

  async findWorkLogsByDate(workDate: string): Promise<RemoteWorkLog[]> {
    const targets = await this.targets();
    return this.api.queryWorkLogsByDate(targets.workLogs.dataSourceId, workDate);
  }

  async createWorkLog(input: CreateWorkLogInput): Promise<string> {
    const targets = await this.targets();
    const properties: NonNullable<CreatePageParameters['properties']> = {
      Name: { type: 'title', title: richText(input.title) },
      Date: { type: 'date', date: { start: input.workDate } },
      Summary: { type: 'rich_text', rich_text: richText(input.summary) },
      'Local ID': { type: 'rich_text', rich_text: richText(input.localId) },
    };
    if (input.repositoryUrl) properties.Repository = { type: 'url', url: input.repositoryUrl };
    const repositorySections = input.repositories.flatMap((repository) => [
      `## ${repository.name}`,
      ...(repository.url ? [`Repository: ${repository.url}`, ''] : []),
      ...repository.workItems.flatMap((item) => [
        `### ${item.title}`,
        item.details || '_No additional details were supplied._',
        '',
        `- Verification: ${item.verificationStatus}`,
        `- Source events: ${item.sourceEventIds.join(', ')}`,
        '',
      ]),
    ]);
    const markdown = [
      '## Daily Summary',
      input.summary,
      '',
      ...repositorySections,
      `Approved draft: ${input.draftId} v${input.draftVersion}`,
    ].join('\n');
    return this.api.createPage({
      parent: { type: 'data_source_id', data_source_id: targets.workLogs.dataSourceId },
      properties,
      markdown,
    });
  }
}
