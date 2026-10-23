import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { saveConfig } from '../src/config/index.js';
import { JsonEventStore } from '../src/storage/json-store.js';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('MCP stdio server', () => {
  it('exposes ping and responds with pong', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve(projectRoot, 'src/index.ts')],
      cwd: projectRoot,
      stderr: 'pipe',
    });
    const client = new Client({ name: 'local-devlog-mcp-test', version: '1.0.0' });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toContain('ping');

      const result = await client.callTool({ name: 'ping', arguments: {} });
      expect(result.content).toEqual([{ type: 'text', text: 'pong' }]);
    } finally {
      await client.close();
    }
  });

  it('returns persisted activity for a local calendar date', async () => {
    const dataDirectory = await mkdtemp(`${tmpdir()}/local-devlog-mcp-tool-`);
    const localSha = '1'.repeat(40);
    const identity = {
      repositoryId: '2'.repeat(64),
      repositoryName: 'example',
      repositoryPath: resolve(dataDirectory, 'missing-repository'),
      remoteName: 'origin',
      remoteUrl: 'https://example.invalid/repo.git',
      localRef: 'refs/heads/main',
      localSha,
      remoteRef: 'refs/heads/main',
      remoteSha: '0'.repeat(40),
    };
    await saveConfig({ version: 1, timezone: 'Asia/Seoul', repositories: [] }, dataDirectory);
    await new JsonEventStore(dataDirectory).append([{
      id: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
      ...identity,
      recordedAt: '2026-10-22T15:30:00.000Z',
      commits: [{ sha: localSha, subject: 'MCP activity', authorName: 'Test User' }],
      commitsTruncated: false,
    }]);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve(projectRoot, 'src/index.ts')],
      cwd: projectRoot,
      env: { LOCAL_DEVLOG_DATA_DIR: dataDirectory },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'local-devlog-mcp-activity-test', version: '1.0.0' });

    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'get_daily_activity', arguments: { date: '2026-10-23' } });
      const block = result.content[0];
      if (!block || block.type !== 'text') throw new Error('Expected text tool output');
      const payload = z.object({
        date: z.string(),
        timezone: z.string(),
        activities: z.array(z.object({
          branch: z.string(),
          commits: z.array(z.object({ subject: z.string() })),
          verification: z.object({ status: z.string() }),
        })),
      }).parse(JSON.parse(block.text));
      expect(payload.date).toBe('2026-10-23');
      expect(payload.timezone).toBe('Asia/Seoul');
      expect(payload.activities[0]).toMatchObject({
        branch: 'main',
        commits: [{ subject: 'MCP activity' }],
        verification: { status: 'UNKNOWN' },
      });
    } finally {
      await client.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });
});
