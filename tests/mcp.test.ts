import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
});
