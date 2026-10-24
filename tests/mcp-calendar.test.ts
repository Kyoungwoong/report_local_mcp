import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { CalendarConnectionValidation } from '../src/adapters/calendar.js';
import { createServer } from '../src/server.js';
import {
  calendarPublicationPhrase,
  type CalendarPublicationPort,
  type CalendarPublicationPreview,
} from '../src/services/calendar-publisher.js';

const draftId = '11111111-1111-4111-8111-111111111111';
const fingerprint = 'c'.repeat(64);
const connection: CalendarConnectionValidation = {
  platform: 'darwin', authorizationStatus: 'FULL_ACCESS', configurationPresent: true, valid: true,
  configured: { identifier: 'calendar-1', title: 'Development', sourceTitle: 'iCloud', allowsContentModifications: true },
  calendars: [{ identifier: 'calendar-1', title: 'Development', sourceTitle: 'iCloud', allowsContentModifications: true }],
};
const preview: CalendarPublicationPreview = {
  draftId, draftVersion: 1, workDate: '2026-10-24', timezone: 'Asia/Seoul',
  localId: `${draftId}:v1:calendar`,
  calendar: { identifier: 'calendar-1', title: 'Development', sourceTitle: 'iCloud' },
  event: { title: '개발 일지 | 2026-10-24', notes: 'notes', notionWorkLogLinks: [] },
  previewFingerprint: fingerprint,
  confirmationPhrase: calendarPublicationPhrase(draftId, 1, fingerprint),
  connection,
};

class FakePublication implements CalendarPublicationPort {
  publishCalls = 0;
  async preview() { return preview; }
  async publish() {
    this.publishCalls += 1;
    return {
      status: 'SYNCED' as const,
      action: 'CREATED' as const,
      record: {
        draftId, draftVersion: 1, localId: preview.localId,
        previewFingerprint: fingerprint, calendarIdentifier: 'calendar-1', workDate: '2026-10-24',
        status: 'SYNCED' as const, attempts: 1, eventIdentifier: 'event-1',
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
      },
    };
  }
  async getStatus() { return { status: 'NOT_STARTED' as const }; }
}

async function connect(publication: FakePublication, elicitation = false) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    '/tmp/local-devlog-unused-calendar-test',
    async () => '<html></html>',
    undefined,
    async () => ({ adapter: { validateConnection: async () => connection }, publication }),
  );
  const client = new Client(
    { name: 'calendar-mcp-test', version: '1.0.0' },
    elicitation ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function payload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  if (!result.structuredContent) throw new Error('Expected structured content');
  return result.structuredContent;
}

describe('Calendar MCP tools', () => {
  it('exposes validation, preview, explicit fallback publication, and status', async () => {
    const publication = new FakePublication();
    const session = await connect(publication);
    try {
      const tools = await session.client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'validate_calendar_connection', 'preview_calendar_publication',
        'publish_to_calendar', 'get_calendar_publication_status',
      ]));
      expect(payload(await session.client.callTool({
        name: 'validate_calendar_connection', arguments: { requestPermission: false },
      }))).toMatchObject({ ok: true, result: { valid: true } });
      expect(payload(await session.client.callTool({
        name: 'preview_calendar_publication', arguments: { draftId, version: 1 },
      }))).toMatchObject({ ok: true, result: { previewFingerprint: fingerprint } });

      const denied = await session.client.callTool({
        name: 'publish_to_calendar',
        arguments: { draftId, version: 1, previewFingerprint: fingerprint, confirmation: 'yes' },
      });
      expect(denied.isError).toBe(true);
      expect(publication.publishCalls).toBe(0);

      const published = await session.client.callTool({
        name: 'publish_to_calendar',
        arguments: {
          draftId, version: 1, previewFingerprint: fingerprint,
          confirmation: calendarPublicationPhrase(draftId, 1, fingerprint),
        },
      });
      expect(payload(published)).toMatchObject({ ok: true, result: { status: 'SYNCED' } });
      expect(publication.publishCalls).toBe(1);
      expect(payload(await session.client.callTool({
        name: 'get_calendar_publication_status', arguments: { draftId, version: 1 },
      }))).toMatchObject({ ok: true, result: { status: 'NOT_STARTED' } });
    } finally {
      await session.client.close();
      await session.server.close();
    }
  });

  it('does not let fallback text bypass native elicitation', async () => {
    const publication = new FakePublication();
    const session = await connect(publication, true);
    let approve = false;
    session.client.setRequestHandler(ElicitRequestSchema, async () => approve
      ? { action: 'accept', content: { approved: true, confirmation: calendarPublicationPhrase(draftId, 1, fingerprint) } }
      : { action: 'decline' });
    const argumentsValue = {
      draftId, version: 1, previewFingerprint: fingerprint,
      confirmation: calendarPublicationPhrase(draftId, 1, fingerprint),
    };
    try {
      const declined = await session.client.callTool({ name: 'publish_to_calendar', arguments: argumentsValue });
      expect(declined.isError).toBe(true);
      expect(publication.publishCalls).toBe(0);
      approve = true;
      const published = await session.client.callTool({ name: 'publish_to_calendar', arguments: argumentsValue });
      expect(published.isError).not.toBe(true);
      expect(publication.publishCalls).toBe(1);
    } finally {
      await session.client.close();
      await session.server.close();
    }
  });
});
