import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDataDirectory } from './config/index.js';
import { getDailyActivity, isCalendarDate } from './services/activity.js';

export function createServer(dataDirectory = getDataDirectory()): McpServer {
  const server = new McpServer({ name: 'local-devlog-mcp', version: '0.1.0' });
  server.tool('ping', 'Check MCP connectivity', {}, async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }));
  server.tool(
    'get_daily_activity',
    'Read Git pre-push attempts for a local calendar date. Results are attempts, not proof that pushes succeeded.',
    { date: z.string().refine(isCalendarDate, 'Expected a real YYYY-MM-DD calendar date') },
    async ({ date }) => {
      try {
        const result = await getDailyActivity(date, dataDirectory);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to read daily activity';
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  );
  return server;
}
