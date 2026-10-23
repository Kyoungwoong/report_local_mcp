import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'local-devlog-mcp', version: '0.1.0' });
server.tool('ping', 'Check MCP connectivity', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}));
server.tool('get_daily_activity', 'Scaffold only: Git activity collection is not implemented',
  { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) },
  async ({ date }) => ({
    content: [{ type: 'text', text: JSON.stringify({ date, status: 'NOT_IMPLEMENTED', activities: [] }) }],
  }));
await server.connect(new StdioServerTransport());
