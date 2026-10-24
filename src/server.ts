import { readFile } from 'node:fs/promises';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CalendarAdapter, type CalendarConnectionValidation } from './adapters/calendar.js';
import { NotionAdapter, type NotionConnectionValidation } from './adapters/notion.js';
import { getDataDirectory, isValidTimeZone } from './config/index.js';
import { loadNotionEnvironment } from './config/notion.js';
import { DailyDraftSchema, DraftContentInputSchema, DraftStatusSchema } from './drafts/types.js';
import { getDailyActivity, isCalendarDate } from './services/activity.js';
import { approvalPhrase, DailyDraftService, DraftError, type DraftResult } from './services/daily-log.js';
import {
  calendarPublicationPhrase,
  type CalendarPublicationPort,
  CalendarPublicationService,
  CalendarPublicationError,
} from './services/calendar-publisher.js';
import {
  notionPublicationPhrase,
  type NotionPublicationPort,
  NotionPublicationService,
  PublicationError,
} from './services/publisher.js';

export const DAILY_DRAFT_APP_URI = 'ui://local-devlog/daily-draft.html';
type AppHtmlLoader = () => Promise<string>;
export type NotionToolServices = {
  adapter: { validateConnection(): Promise<NotionConnectionValidation> };
  publication: NotionPublicationPort;
};
export type NotionToolServicesFactory = () => Promise<NotionToolServices>;
export type CalendarToolServices = {
  adapter: { validateConnection(requestPermission?: boolean): Promise<CalendarConnectionValidation> };
  publication: CalendarPublicationPort;
};
export type CalendarToolServicesFactory = () => Promise<CalendarToolServices>;
const defaultAppHtmlLoader: AppHtmlLoader = () => readFile(new URL('./apps/daily-draft.html', import.meta.url), 'utf8');

const DraftToolOutputShape = {
  ok: z.boolean(),
  draft: DailyDraftSchema.optional(),
  revisions: z.array(DailyDraftSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};
const DraftListOutputShape = {
  ok: z.boolean(),
  drafts: z.array(DailyDraftSchema).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};
const NotionToolOutputShape = {
  ok: z.boolean(),
  result: z.record(z.unknown()).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
};
const appMeta = {
  ui: { resourceUri: DAILY_DRAFT_APP_URI, visibility: ['model', 'app'] as const },
};

function success(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function failure(error: unknown): CallToolResult {
  const knownCode = error instanceof DraftError || error instanceof PublicationError
    || (error instanceof Error && 'code' in error && typeof error.code === 'string')
    ? error.code
    : 'STORAGE_ERROR';
  const payload = {
    ok: false,
    code: knownCode,
    message: error instanceof Error ? error.message : 'Unexpected draft error',
  };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function notionSuccess(result: Record<string, unknown>): CallToolResult {
  return success({ ok: true, result });
}

function draftPayload(result: DraftResult): Record<string, unknown> {
  return { ok: true, draft: result.draft, revisions: result.revisions };
}

export function createServer(
  dataDirectory = getDataDirectory(),
  appHtmlLoader: AppHtmlLoader = defaultAppHtmlLoader,
  notionFactory?: NotionToolServicesFactory,
  calendarFactory?: CalendarToolServicesFactory,
): McpServer {
  const server = new McpServer({ name: 'local-devlog-mcp', version: '0.4.1' });
  const drafts = new DailyDraftService(dataDirectory);
  let notionServices: Promise<NotionToolServices> | undefined;
  const getNotionServices = (): Promise<NotionToolServices> => {
    notionServices ??= notionFactory
      ? notionFactory()
      : loadNotionEnvironment().then((environment) => {
        const adapter = new NotionAdapter(environment);
        return {
          adapter,
          publication: new NotionPublicationService(dataDirectory, adapter),
        };
      });
    return notionServices;
  };
  let calendarServices: Promise<CalendarToolServices> | undefined;
  const getCalendarServices = (): Promise<CalendarToolServices> => {
    calendarServices ??= calendarFactory
      ? calendarFactory()
      : Promise.resolve().then(() => {
        const adapter = new CalendarAdapter(dataDirectory);
        return {
          adapter,
          publication: new CalendarPublicationService(dataDirectory, adapter),
        };
      });
    return calendarServices;
  };

  server.registerTool('ping', {
    description: 'Check MCP connectivity',
    outputSchema: { message: z.literal('pong') },
    annotations: { readOnlyHint: true },
  }, async () => ({
    content: [{ type: 'text', text: 'pong' }],
    structuredContent: { message: 'pong' },
  }));

  server.registerTool('get_daily_activity', {
    description: 'Read Git pre-push attempts for a local calendar date. Results are attempts, not proof that pushes succeeded.',
    inputSchema: { date: z.string().refine(isCalendarDate, 'Expected a real YYYY-MM-DD calendar date') },
    annotations: { readOnlyHint: true },
  }, async ({ date }) => {
    try {
      return success(await getDailyActivity(date, dataDirectory));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read daily activity';
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });

  registerAppTool(server, 'save_daily_draft', {
    title: 'Save daily draft',
    description: 'Persist an AI-proposed daily draft. This does not approve or publish it.',
    inputSchema: {
      workDate: z.string().refine(isCalendarDate, 'Expected a real YYYY-MM-DD calendar date'),
      timezone: z.string().refine(isValidTimeZone, 'Expected a valid IANA timezone'),
      ...DraftContentInputSchema.shape,
    },
    outputSchema: DraftToolOutputShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: appMeta,
  }, async (input) => {
    try {
      return success(draftPayload(await drafts.save(input)));
    } catch (error) {
      return failure(error);
    }
  });

  registerAppTool(server, 'get_daily_draft', {
    title: 'Get daily draft',
    description: 'Read a daily draft and all of its immutable revisions.',
    inputSchema: { draftId: z.string().uuid() },
    outputSchema: DraftToolOutputShape,
    annotations: { readOnlyHint: true },
    _meta: appMeta,
  }, async ({ draftId }) => {
    try {
      return success(draftPayload(await drafts.get(draftId)));
    } catch (error) {
      return failure(error);
    }
  });

  registerAppTool(server, 'list_daily_drafts', {
    title: 'List daily drafts',
    description: 'List current daily draft versions, optionally filtered by date, timezone, or status.',
    inputSchema: {
      workDate: z.string().refine(isCalendarDate).optional(),
      timezone: z.string().refine(isValidTimeZone).optional(),
      status: DraftStatusSchema.optional(),
    },
    outputSchema: DraftListOutputShape,
    annotations: { readOnlyHint: true },
    _meta: appMeta,
  }, async (filters) => {
    try {
      return success({ ok: true, drafts: await drafts.list(filters) });
    } catch (error) {
      return failure(error);
    }
  });

  registerAppTool(server, 'update_daily_draft', {
    title: 'Update daily draft',
    description: 'Create a new immutable revision after checking the current version. Use REJECTED to reject and PENDING to edit or reopen.',
    inputSchema: {
      draftId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      status: z.enum(['PENDING', 'REJECTED']),
      ...DraftContentInputSchema.shape,
    },
    outputSchema: DraftToolOutputShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    _meta: appMeta,
  }, async (input) => {
    try {
      return success(draftPayload(await drafts.update(input)));
    } catch (error) {
      return failure(error);
    }
  });

  registerAppTool(server, 'approve_daily_draft', {
    title: 'Approve daily draft',
    description: 'Approve one exact persisted draft version after explicit human confirmation. This does not publish externally.',
    inputSchema: {
      draftId: z.string().uuid(),
      version: z.number().int().positive(),
      confirmation: z.string().optional(),
    },
    outputSchema: DraftToolOutputShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    _meta: appMeta,
  }, async ({ draftId, version, confirmation }) => {
    try {
      const current = await drafts.get(draftId);
      if (current.draft.status === 'APPROVED' && current.draft.approvedVersion === version) {
        return success(draftPayload(current));
      }
      if (current.draft.version !== version) {
        throw new DraftError('VERSION_CONFLICT', `Expected version ${version}, current version is ${current.draft.version}`);
      }
      if (current.draft.status === 'REJECTED') {
        throw new DraftError('DRAFT_REJECTED', 'Rejected drafts must be reopened before approval');
      }

      const phrase = approvalPhrase(draftId, version);
      const supportsFormElicitation = server.server.getClientCapabilities()?.elicitation?.form !== undefined;
      if (supportsFormElicitation) {
        const latestActivity = await getDailyActivity(current.draft.workDate, dataDirectory, current.draft.timezone);
        const sourceNotice = latestActivity.sourceFingerprint === current.draft.sourceFingerprint
          ? 'Git sources are unchanged since this draft was saved.'
          : 'Warning: new Git activity exists since this draft was saved.';
        const verificationNotice = current.draft.workItems.every(({ verificationStatus }) => verificationStatus === 'REMOTE_MATCH')
          ? 'All referenced work items currently have a remote match.'
          : 'Some referenced work items are unconfirmed.';
        let elicitation;
        try {
          elicitation = await server.server.elicitInput({
            mode: 'form',
            message: `Approve ${current.draft.workDate} draft v${version}? ${sourceNotice} ${verificationNotice} Summary: ${current.draft.summary.slice(0, 300)}`,
            requestedSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean', title: 'I explicitly approve this exact draft version' },
                confirmation: {
                  type: 'string',
                  title: `Type ${phrase}`,
                  minLength: phrase.length,
                  maxLength: phrase.length,
                },
              },
              required: ['approved', 'confirmation'],
            },
          });
        } catch {
          throw new DraftError('INVALID_CONFIRMATION', 'The host could not complete the approval elicitation');
        }
        if (elicitation.action !== 'accept'
          || elicitation.content?.approved !== true
          || elicitation.content.confirmation !== phrase) {
          throw new DraftError('INVALID_CONFIRMATION', 'Approval was declined, cancelled, or did not match the exact draft version');
        }
        return success(draftPayload(await drafts.approve(draftId, version, 'MCP_ELICITATION')));
      }

      if (confirmation !== phrase) {
        throw new DraftError('INVALID_CONFIRMATION', `This client does not support form elicitation. Type exactly: ${phrase}`);
      }
      return success(draftPayload(await drafts.approve(draftId, version, 'EXPLICIT_CONFIRMATION_FALLBACK')));
    } catch (error) {
      return failure(error);
    }
  });

  registerAppResource(server, 'Daily draft review', DAILY_DRAFT_APP_URI, {
    description: 'Interactive review, editing, rejection, reopening, and approval for local daily drafts.',
    _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
  }, async () => ({
    contents: [{
      uri: DAILY_DRAFT_APP_URI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await appHtmlLoader(),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } },
    }],
  }));

  server.registerTool('validate_notion_connection', {
    description: 'Read Notion authentication, Database, Data Source, and property schemas without modifying Notion.',
    outputSchema: NotionToolOutputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => {
    try {
      const { adapter } = await getNotionServices();
      return notionSuccess(await adapter.validateConnection());
    } catch (error) {
      return failure(error);
    }
  });

  const publicationInput = {
    draftId: z.string().uuid(),
    version: z.number().int().positive(),
    selectedNextActionIndexes: z.array(z.number().int().nonnegative()).max(100),
  };

  server.registerTool('preview_notion_publication', {
    description: 'Preview Work Logs and explicitly selected Tasks for one approved draft version. This performs no Notion writes.',
    inputSchema: publicationInput,
    outputSchema: NotionToolOutputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const { publication } = await getNotionServices();
      return notionSuccess(await publication.preview(input));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('publish_to_notion', {
    description: 'Publish an exact, previously previewed approved draft version after explicit user confirmation.',
    inputSchema: {
      ...publicationInput,
      previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      confirmation: z.string().optional(),
    },
    outputSchema: NotionToolOutputShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ confirmation, ...input }) => {
    try {
      const { publication } = await getNotionServices();
      const preview = await publication.preview(input);
      if (preview.previewFingerprint !== input.previewFingerprint) {
        throw new PublicationError('PREVIEW_MISMATCH', 'Publication preview changed; preview and confirm it again');
      }
      const phrase = notionPublicationPhrase(input.draftId, input.version, input.previewFingerprint);
      const supportsFormElicitation = server.server.getClientCapabilities()?.elicitation?.form !== undefined;
      if (supportsFormElicitation) {
        let elicitation;
        try {
          elicitation = await server.server.elicitInput({
            mode: 'form',
            message: `Publish approved draft ${preview.workDate} v${preview.draftVersion} to Notion? This will create ${preview.workLogs.length} Work Log(s) and ${preview.tasks.length} selected Task(s).`,
            requestedSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean', title: 'I explicitly authorize these Notion writes' },
                confirmation: {
                  type: 'string',
                  title: `Type ${phrase}`,
                  minLength: phrase.length,
                  maxLength: phrase.length,
                },
              },
              required: ['approved', 'confirmation'],
            },
          });
        } catch {
          throw new PublicationError('PUBLICATION_NOT_AUTHORIZED', 'The host could not complete publication confirmation');
        }
        if (elicitation.action !== 'accept'
          || elicitation.content?.approved !== true
          || elicitation.content.confirmation !== phrase) {
          throw new PublicationError('PUBLICATION_NOT_AUTHORIZED', 'Notion publication was declined, cancelled, or not confirmed exactly');
        }
      } else if (confirmation !== phrase) {
        throw new PublicationError('PUBLICATION_NOT_AUTHORIZED', `This client does not support form elicitation. Type exactly: ${phrase}`);
      }
      return notionSuccess(await publication.publish({ ...input, publicationAuthorized: true }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('get_notion_publication_status', {
    description: 'Read local per-item Notion publication and retry status for one draft version.',
    inputSchema: { draftId: z.string().uuid(), version: z.number().int().positive() },
    outputSchema: NotionToolOutputShape,
    annotations: { readOnlyHint: true },
  }, async ({ draftId, version }) => {
    try {
      const { publication } = await getNotionServices();
      return notionSuccess(await publication.getStatus(draftId, version));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('validate_calendar_connection', {
    description: 'Inspect Apple Calendar permission and configured target. Set requestPermission only when the user wants the macOS full-access prompt.',
    inputSchema: { requestPermission: z.boolean().optional().default(false) },
    outputSchema: NotionToolOutputShape,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ requestPermission }) => {
    try {
      const { adapter } = await getCalendarServices();
      return notionSuccess(await adapter.validateConnection(requestPermission));
    } catch (error) {
      return failure(error);
    }
  });

  const calendarPublicationInput = {
    draftId: z.string().uuid(),
    version: z.number().int().positive(),
  };

  server.registerTool('preview_calendar_publication', {
    description: 'Preview one all-day Apple Calendar event for an exact approved draft version. This performs no Calendar write.',
    inputSchema: calendarPublicationInput,
    outputSchema: NotionToolOutputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const { publication } = await getCalendarServices();
      return notionSuccess(await publication.preview(input));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('publish_to_calendar', {
    description: 'Publish an exact, previously previewed approved draft version to Apple Calendar after explicit user confirmation.',
    inputSchema: {
      ...calendarPublicationInput,
      previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      confirmation: z.string().optional(),
    },
    outputSchema: NotionToolOutputShape,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ confirmation, ...input }) => {
    try {
      const { publication } = await getCalendarServices();
      const preview = await publication.preview(input);
      if (preview.previewFingerprint !== input.previewFingerprint) {
        throw new CalendarPublicationError('PREVIEW_MISMATCH', 'Calendar preview changed; preview and confirm it again');
      }
      const phrase = calendarPublicationPhrase(input.draftId, input.version, input.previewFingerprint);
      const supportsFormElicitation = server.server.getClientCapabilities()?.elicitation?.form !== undefined;
      if (supportsFormElicitation) {
        let elicitation;
        try {
          elicitation = await server.server.elicitInput({
            mode: 'form',
            message: `Publish approved draft ${preview.workDate} v${preview.draftVersion} as an all-day event in ${preview.calendar.title}?`,
            requestedSchema: {
              type: 'object',
              properties: {
                approved: { type: 'boolean', title: 'I explicitly authorize this Apple Calendar write' },
                confirmation: {
                  type: 'string',
                  title: `Type ${phrase}`,
                  minLength: phrase.length,
                  maxLength: phrase.length,
                },
              },
              required: ['approved', 'confirmation'],
            },
          });
        } catch {
          throw new CalendarPublicationError('PUBLICATION_NOT_AUTHORIZED', 'The host could not complete Calendar confirmation');
        }
        if (elicitation.action !== 'accept'
          || elicitation.content?.approved !== true
          || elicitation.content.confirmation !== phrase) {
          throw new CalendarPublicationError('PUBLICATION_NOT_AUTHORIZED', 'Calendar publication was declined, cancelled, or not confirmed exactly');
        }
      } else if (confirmation !== phrase) {
        throw new CalendarPublicationError('PUBLICATION_NOT_AUTHORIZED', `This client does not support form elicitation. Type exactly: ${phrase}`);
      }
      return notionSuccess(await publication.publish({ ...input, publicationAuthorized: true }));
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('get_calendar_publication_status', {
    description: 'Read local Apple Calendar publication state and verify the event when Calendar access is available.',
    inputSchema: calendarPublicationInput,
    outputSchema: NotionToolOutputShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ draftId, version }) => {
    try {
      const { publication } = await getCalendarServices();
      return notionSuccess(await publication.getStatus(draftId, version));
    } catch (error) {
      return failure(error);
    }
  });

  return server;
}
