import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const HOOK_MARKER = '# local-devlog-mcp managed pre-push hook v1';

export type HookCommand = {
  nodePath: string;
  runnerPath: string;
  repositoryId: string;
  repositoryPath: string;
  dataDirectory: string;
};

export class ExistingHookError extends Error {
  constructor(readonly hookPath: string) {
    super(`Refusing to overwrite existing pre-push hook: ${hookPath}. Remove it explicitly or chain local-devlog-mcp manually.`);
  }
}

export class ModifiedHookError extends Error {
  constructor(readonly hookPath: string) {
    super(`Refusing to remove a pre-push hook that no longer exactly matches the installed local-devlog-mcp hook: ${hookPath}`);
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function createHookScript(command: HookCommand): string {
  const args = [
    command.nodePath,
    command.runnerPath,
    '--repository-id', command.repositoryId,
    '--repository-path', command.repositoryPath,
    '--data-dir', command.dataDirectory,
  ].map(shellQuote).join(' ');
  return `#!/bin/sh\n${HOOK_MARKER}\n# repository-id: ${command.repositoryId}\n${args} "$@" || {\n  printf '%s\\n' 'local-devlog-mcp: collection failed; allowing push to continue.' >&2\n}\nexit 0\n`;
}

export function hashHook(contents: string): string {
  return createHash('sha256').update(contents).digest('hex');
}

export async function installHook(
  hookPath: string,
  command: HookCommand,
): Promise<{ status: 'INSTALLED' | 'ALREADY_INSTALLED'; hash: string }> {
  const contents = createHookScript(command);
  const hash = hashHook(contents);
  try {
    const existing = await readFile(hookPath, 'utf8');
    if (existing === contents) return { status: 'ALREADY_INSTALLED', hash };
    throw new ExistingHookError(hookPath);
  } catch (error) {
    if (error instanceof ExistingHookError) throw error;
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  await mkdir(dirname(hookPath), { recursive: true });
  try {
    await writeFile(hookPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o755 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
    const existing = await readFile(hookPath, 'utf8');
    if (existing === contents) return { status: 'ALREADY_INSTALLED', hash };
    throw new ExistingHookError(hookPath);
  }
  await chmod(hookPath, 0o755);
  return { status: 'INSTALLED', hash };
}

export async function uninstallHook(
  hookPath: string,
  expectedHash: string,
): Promise<'REMOVED' | 'ALREADY_REMOVED'> {
  let contents: string;
  try {
    contents = await readFile(hookPath, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return 'ALREADY_REMOVED';
    throw error;
  }
  if (!contents.includes(HOOK_MARKER) || hashHook(contents) !== expectedHash) {
    throw new ModifiedHookError(hookPath);
  }
  await unlink(hookPath);
  return 'REMOVED';
}
