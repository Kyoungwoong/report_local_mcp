import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CalendarAdapter } from '../adapters/calendar.js';
import { getDataDirectory, loadConfig, saveConfig } from '../config/index.js';
import { addRepository, removeRepository, updateTimezone } from '../services/repositories.js';

const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const runnerPath = resolve(packageRoot, 'dist/git/hook-runner.js');
const dataDirectory = getDataDirectory();

function usage(): void {
  process.stdout.write(`Local DevLog MCP setup\n\n`);
  process.stdout.write(`  pnpm run setup -- add <repository> [repository...]\n`);
  process.stdout.write(`  pnpm run setup -- remove <repository> [repository...]\n`);
  process.stdout.write(`  pnpm run setup -- list\n`);
  process.stdout.write(`  pnpm run setup -- timezone <IANA timezone>\n`);
  process.stdout.write(`  pnpm run setup -- calendar list\n`);
  process.stdout.write(`  pnpm run setup -- calendar set <calendar-identifier>\n`);
  process.stdout.write(`  pnpm run setup -- calendar clear\n`);
}

async function configureCalendar(args: string[]): Promise<void> {
  const action = args[0];
  if (!['list', 'set', 'clear'].includes(action ?? '')) {
    throw new Error('calendar requires list, set <calendar-identifier>, or clear');
  }
  const config = await loadConfig(dataDirectory);
  if (action === 'clear') {
    if (args.length !== 1) throw new Error('calendar clear takes no identifier');
    const { calendar: _removed, ...next } = config;
    await saveConfig(next, dataDirectory);
    process.stderr.write('Calendar selection cleared. Existing events were not changed.\n');
    return;
  }
  const adapter = new CalendarAdapter(dataDirectory);
  const validation = await adapter.validateConnection(true);
  const calendars = validation.calendars;
  if (action === 'list') {
    if (args.length !== 1) throw new Error('calendar list takes no identifier');
    process.stdout.write(`${JSON.stringify({
      authorizationStatus: validation.authorizationStatus,
      configured: validation.configured,
      calendars,
    }, null, 2)}\n`);
    return;
  }
  if (validation.authorizationStatus !== 'FULL_ACCESS') {
    throw new Error(`Calendar full access is required (${validation.authorizationStatus})`);
  }
  if (args.length !== 2) throw new Error('calendar set requires exactly one calendar identifier');
  const selected = calendars.find(({ identifier }) => identifier === args[1]);
  if (!selected) throw new Error('Calendar identifier was not found');
  if (!selected.allowsContentModifications) throw new Error('Selected Calendar is read-only');
  await saveConfig({
    ...config,
    calendar: {
      identifier: selected.identifier,
      title: selected.title,
      sourceTitle: selected.sourceTitle,
    },
  }, dataDirectory);
  process.stderr.write(`Calendar set to ${selected.title} (${selected.sourceTitle}).\n`);
}

async function main(args: string[]): Promise<void> {
  if (args[0] === '--') args = args.slice(1);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    return;
  }
  const command = ['add', 'remove', 'list', 'timezone', 'calendar'].includes(args[0] ?? '') ? args[0] : 'add';
  const values = command === args[0] ? args.slice(1) : args;

  if (command === 'calendar') {
    await configureCalendar(values);
    return;
  }

  if (command === 'list') {
    const config = await loadConfig(dataDirectory);
    process.stdout.write(`${JSON.stringify({ dataDirectory, ...config }, null, 2)}\n`);
    return;
  }
  if (command === 'timezone') {
    if (values.length !== 1) throw new Error('timezone requires exactly one IANA timezone');
    await updateTimezone(values[0]!, dataDirectory);
    process.stderr.write(`Timezone set to ${values[0]}.\n`);
    return;
  }
  if (values.length === 0) throw new Error(`${command} requires at least one repository path`);

  if (command === 'add') {
    await access(runnerPath).catch(() => {
      throw new Error(`Built hook runner not found at ${runnerPath}. Run pnpm build first.`);
    });
    for (const repositoryPath of values) {
      const result = await addRepository(repositoryPath, {
        dataDirectory,
        nodePath: process.execPath,
        runnerPath,
      });
      process.stderr.write(`${result.duplicate ? 'Already registered' : 'Registered'} ${result.repository.path} (${result.hookStatus}).\n`);
    }
    return;
  }

  for (const repositoryPath of values) {
    const result = await removeRepository(repositoryPath, dataDirectory);
    process.stderr.write(`${result.removed ? 'Removed' : 'Not registered'} ${repositoryPath} (${result.hookStatus}).\n`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown setup error';
  process.stderr.write(`local-devlog-mcp setup: ${message}\n`);
  process.exitCode = 1;
});
