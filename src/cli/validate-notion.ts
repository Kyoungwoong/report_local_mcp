import { NotionAdapter, NotionAdapterError } from '../adapters/notion.js';
import { loadNotionEnvironment } from '../config/notion.js';

try {
  const environment = await loadNotionEnvironment();
  const validation = await new NotionAdapter(environment).validateConnection();
  process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
  if (!validation.valid) process.exitCode = 1;
} catch (error) {
  const payload = {
    ok: false,
    code: error instanceof NotionAdapterError ? error.code : 'NOTION_CONFIG_ERROR',
    message: error instanceof Error ? error.message : 'Notion validation failed',
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
}

