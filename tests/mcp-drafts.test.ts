import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig } from '../src/config/index.js';
import type { PushAttempt } from '../src/git/types.js';
import { DAILY_DRAFT_APP_URI, createServer } from '../src/server.js';
import { getDailyActivity } from '../src/services/activity.js';
import { approvalPhrase } from '../src/services/daily-log.js';
import { JsonEventStore } from '../src/storage/json-store.js';

const directories: string[] = [];

async function dataFixture(): Promise<{
  dataDirectory: string;
  saveArguments: Record<string, unknown>;
}> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'local-devlog-mcp-drafts-'));
  directories.push(dataDirectory);
  await saveConfig({ version: 1, timezone: 'Asia/Seoul', repositories: [] }, dataDirectory);
  const event: PushAttempt = {
    id: 'a'.repeat(64),
    repositoryId: 'b'.repeat(64),
    repositoryName: 'mcp-example',
    repositoryPath: join(dataDirectory, 'missing'),
    remoteName: 'origin',
    remoteUrl: 'https://example.invalid/repository.git',
    localRef: 'refs/heads/main',
    localSha: 'c'.repeat(40),
    remoteRef: 'refs/heads/main',
    remoteSha: '0'.repeat(40),
    recordedAt: '2026-10-22T15:30:00.000Z',
    commits: [{ sha: 'c'.repeat(40), subject: 'MCP draft tools', authorName: 'Test User' }],
    commitsTruncated: false,
  };
  await new JsonEventStore(dataDirectory).append([event]);
  const activity = await getDailyActivity('2026-10-23', dataDirectory);
  return {
    dataDirectory,
    saveArguments: {
      workDate: '2026-10-23',
      timezone: 'Asia/Seoul',
      summary: 'Implemented MCP draft tools.',
      workItems: [{
        repositoryId: event.repositoryId,
        title: 'MCP tools',
        details: 'Added validated operations.',
        sourceEventIds: [event.id],
      }],
      nextActions: ['Review the draft'],
      sourceEventIds: [event.id],
      sourceFingerprint: activity.sourceFingerprint,
    },
  };
}

async function connectedClient(
  dataDirectory: string,
  capabilities: ConstructorParameters<typeof Client>[1] = {},
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(dataDirectory, async () => '<!doctype html><html><body>test app</body></html>');
  const client = new Client({ name: 'draft-test', version: '1.0.0' }, capabilities);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function structured(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  if (!result.structuredContent) throw new Error('Expected structured tool content');
  return result.structuredContent;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('draft MCP tools and App resource', () => {
  it('advertises App metadata, serves self-contained HTML, and supports structured draft CRUD', async () => {
    const fixture = await dataFixture();
    const connection = await connectedClient(fixture.dataDirectory);
    try {
      const tools = await connection.client.listTools();
      const saveTool = tools.tools.find(({ name }) => name === 'save_daily_draft');
      expect(saveTool?._meta).toMatchObject({
        ui: { resourceUri: DAILY_DRAFT_APP_URI, visibility: ['model', 'app'] },
        'ui/resourceUri': DAILY_DRAFT_APP_URI,
      });
      const resource = await connection.client.readResource({ uri: DAILY_DRAFT_APP_URI });
      expect(resource.contents[0]).toMatchObject({
        uri: DAILY_DRAFT_APP_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: expect.stringContaining('test app'),
      });

      const savedPayload = structured(await connection.client.callTool({ name: 'save_daily_draft', arguments: fixture.saveArguments }));
      const saved = savedPayload.draft as { draftId: string; version: number; status: string };
      expect(saved).toMatchObject({ version: 1, status: 'PENDING' });
      const listed = structured(await connection.client.callTool({ name: 'list_daily_drafts', arguments: { workDate: '2026-10-23' } }));
      expect(listed.drafts).toEqual([expect.objectContaining({ draftId: saved.draftId })]);
      const updated = structured(await connection.client.callTool({
        name: 'update_daily_draft',
        arguments: {
          ...fixture.saveArguments,
          draftId: saved.draftId,
          expectedVersion: 1,
          status: 'PENDING',
          summary: 'Edited through the MCP tool.',
        },
      }));
      expect(updated.draft).toMatchObject({ version: 2, summary: 'Edited through the MCP tool.' });
      const fetched = structured(await connection.client.callTool({
        name: 'get_daily_draft', arguments: { draftId: saved.draftId },
      }));
      expect(fetched.revisions).toEqual([
        expect.objectContaining({ version: 1 }),
        expect.objectContaining({ version: 2 }),
      ]);

      const invalidApproval = await connection.client.callTool({
        name: 'approve_daily_draft', arguments: { draftId: saved.draftId, version: 2, confirmation: 'yes' },
      });
      expect(invalidApproval.isError).toBe(true);
      expect(structured(invalidApproval)).toMatchObject({ code: 'INVALID_CONFIRMATION' });

      const approved = structured(await connection.client.callTool({
        name: 'approve_daily_draft',
        arguments: { draftId: saved.draftId, version: 2, confirmation: approvalPhrase(saved.draftId, 2) },
      }));
      expect(approved.draft).toMatchObject({ status: 'APPROVED', approvalMethod: 'EXPLICIT_CONFIRMATION_FALLBACK' });
    } finally {
      await connection.close();
    }
  });

  it('requires native form elicitation and ignores a tool-provided fallback when supported', async () => {
    const fixture = await dataFixture();
    let response: 'accept' | 'decline' | 'cancel' | 'wrong' = 'decline';
    let expectedPhrase = '';
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer(fixture.dataDirectory, async () => '<html></html>');
    const client = new Client(
      { name: 'elicitation-test', version: '1.0.0' },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async () => {
      if (response === 'accept') return { action: 'accept', content: { approved: true, confirmation: expectedPhrase } };
      if (response === 'wrong') return { action: 'accept', content: { approved: true, confirmation: 'wrong' } };
      return { action: response };
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const savedPayload = structured(await client.callTool({ name: 'save_daily_draft', arguments: fixture.saveArguments }));
      const draft = savedPayload.draft as { draftId: string; version: number };
      expectedPhrase = approvalPhrase(draft.draftId, draft.version);

      const declined = await client.callTool({
        name: 'approve_daily_draft',
        arguments: { draftId: draft.draftId, version: draft.version, confirmation: expectedPhrase },
      });
      expect(declined.isError).toBe(true);
      expect(structured(declined)).toMatchObject({ code: 'INVALID_CONFIRMATION' });

      response = 'cancel';
      const cancelled = await client.callTool({
        name: 'approve_daily_draft', arguments: { draftId: draft.draftId, version: draft.version },
      });
      expect(cancelled.isError).toBe(true);

      response = 'wrong';
      const wrong = await client.callTool({
        name: 'approve_daily_draft', arguments: { draftId: draft.draftId, version: draft.version },
      });
      expect(wrong.isError).toBe(true);

      response = 'accept';
      const approved = structured(await client.callTool({
        name: 'approve_daily_draft',
        arguments: { draftId: draft.draftId, version: draft.version, confirmation: 'wrong-but-ignored' },
      }));
      expect(approved.draft).toMatchObject({ status: 'APPROVED', approvalMethod: 'MCP_ELICITATION' });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
