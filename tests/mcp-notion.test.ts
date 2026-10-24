import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import type { NotionConnectionValidation } from '../src/adapters/notion.js';
import { createServer } from '../src/server.js';
import {
  notionPublicationPhrase,
  type NotionPublicationPort,
  type NotionPublicationPreview,
} from '../src/services/publisher.js';

const draftId = '11111111-1111-4111-8111-111111111111';
const previewFingerprint = 'a'.repeat(64);
const connection: NotionConnectionValidation = {
  authenticated: true,
  botName: 'report-mcp',
  apiVersion: '2026-03-11',
  valid: true,
  tasks: { label: 'Tasks', databaseId: 'db-1', dataSourceId: 'ds-1', title: 'Tasks', properties: {}, mismatches: [], warnings: [], valid: true },
  workLogs: { label: 'Work Logs', databaseId: 'db-2', dataSourceId: 'ds-2', title: 'Work Logs', properties: {}, mismatches: [], warnings: [], valid: true },
};
const preview: NotionPublicationPreview = {
  draftId,
  draftVersion: 1,
  workDate: '2026-10-24',
  selectedNextActionIndexes: [0],
  workLogs: [],
  tasks: [],
  previewFingerprint,
  confirmationPhrase: notionPublicationPhrase(draftId, 1, previewFingerprint),
  notion: connection,
};

class FakePublication implements NotionPublicationPort {
  publishCalls = 0;

  async preview(): Promise<NotionPublicationPreview> {
    return preview;
  }

  async publish() {
    this.publishCalls += 1;
    return {
      status: 'SYNCED' as const,
      record: {
        draftId,
        draftVersion: 1,
        selectedNextActionIndexes: [0],
        lastPreviewFingerprint: previewFingerprint,
        items: [],
        createdAt: '2026-10-24T00:00:00.000Z',
        updatedAt: '2026-10-24T00:00:00.000Z',
      },
      synced: 0,
      failed: 0,
      skipped: 0,
    };
  }

  async getStatus() {
    return { status: 'NOT_STARTED' as const };
  }
}

function resultPayload(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  if (!result.structuredContent) throw new Error('Expected structured content');
  return result.structuredContent;
}

async function connect(publication: FakePublication, elicitation = false) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(
    '/tmp/local-devlog-unused-notion-test',
    async () => '<html></html>',
    async () => ({ adapter: { validateConnection: async () => connection }, publication }),
  );
  const client = new Client(
    { name: 'notion-mcp-test', version: '1.0.0' },
    elicitation ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  return { client, server, clientTransport, serverTransport };
}

describe('Notion MCP tools', () => {
  it('returns structured validation, preview, fallback publication, and status results', async () => {
    const publication = new FakePublication();
    const session = await connect(publication);
    await session.server.connect(session.serverTransport);
    await session.client.connect(session.clientTransport);
    try {
      const tools = await session.client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
        'validate_notion_connection',
        'preview_notion_publication',
        'publish_to_notion',
        'get_notion_publication_status',
      ]));
      expect(resultPayload(await session.client.callTool({ name: 'validate_notion_connection', arguments: {} })))
        .toMatchObject({ ok: true, result: { authenticated: true, valid: true } });
      expect(resultPayload(await session.client.callTool({
        name: 'preview_notion_publication',
        arguments: { draftId, version: 1, selectedNextActionIndexes: [0] },
      }))).toMatchObject({ ok: true, result: { previewFingerprint } });

      const denied = await session.client.callTool({
        name: 'publish_to_notion',
        arguments: { draftId, version: 1, selectedNextActionIndexes: [0], previewFingerprint, confirmation: 'yes' },
      });
      expect(denied.isError).toBe(true);
      expect(publication.publishCalls).toBe(0);

      const published = await session.client.callTool({
        name: 'publish_to_notion',
        arguments: {
          draftId,
          version: 1,
          selectedNextActionIndexes: [0],
          previewFingerprint,
          confirmation: notionPublicationPhrase(draftId, 1, previewFingerprint),
        },
      });
      expect(resultPayload(published)).toMatchObject({ ok: true, result: { status: 'SYNCED' } });
      expect(publication.publishCalls).toBe(1);
      expect(resultPayload(await session.client.callTool({
        name: 'get_notion_publication_status', arguments: { draftId, version: 1 },
      }))).toMatchObject({ ok: true, result: { status: 'NOT_STARTED' } });
    } finally {
      await session.client.close();
      await session.server.close();
    }
  });

  it('does not let a supplied fallback phrase bypass native elicitation', async () => {
    const publication = new FakePublication();
    const session = await connect(publication, true);
    let accept = false;
    session.client.setRequestHandler(ElicitRequestSchema, async () => accept
      ? { action: 'accept', content: { approved: true, confirmation: notionPublicationPhrase(draftId, 1, previewFingerprint) } }
      : { action: 'decline' });
    await session.server.connect(session.serverTransport);
    await session.client.connect(session.clientTransport);
    const argumentsValue = {
      draftId,
      version: 1,
      selectedNextActionIndexes: [0],
      previewFingerprint,
      confirmation: notionPublicationPhrase(draftId, 1, previewFingerprint),
    };
    try {
      const declined = await session.client.callTool({ name: 'publish_to_notion', arguments: argumentsValue });
      expect(declined.isError).toBe(true);
      expect(publication.publishCalls).toBe(0);
      accept = true;
      const published = await session.client.callTool({ name: 'publish_to_notion', arguments: argumentsValue });
      expect(published.isError).not.toBe(true);
      expect(publication.publishCalls).toBe(1);
    } finally {
      await session.client.close();
      await session.server.close();
    }
  });
});
