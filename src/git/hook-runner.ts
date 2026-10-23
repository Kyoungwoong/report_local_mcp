import { collectPushAttempts } from './collector.js';

type HookOptions = {
  repositoryId: string;
  repositoryPath: string;
  dataDirectory: string;
  remoteName: string;
  remoteUrl: string;
};

function parseArguments(args: string[]): HookOptions {
  const values = new Map<string, string>();
  let index = 0;
  while (index < args.length && args[index]?.startsWith('--')) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || value === undefined) throw new Error('Missing hook runner argument');
    values.set(key, value);
    index += 2;
  }
  const remoteName = args[index];
  const remoteUrl = args[index + 1];
  const repositoryId = values.get('--repository-id');
  const repositoryPath = values.get('--repository-path');
  const dataDirectory = values.get('--data-dir');
  if (!repositoryId || !repositoryPath || !dataDirectory || !remoteName || !remoteUrl) {
    throw new Error('Invalid hook runner arguments');
  }
  return { repositoryId, repositoryPath, dataDirectory, remoteName, remoteUrl };
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const options = parseArguments(process.argv.slice(2));
  await collectPushAttempts({ ...options, stdin: await readStandardInput() });
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown collection error';
  process.stderr.write(`local-devlog-mcp: ${message}\n`);
  process.exitCode = 1;
}
