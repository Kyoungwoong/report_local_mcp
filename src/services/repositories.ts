import { createHash } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import {
  loadConfig,
  saveConfig,
  type RepositoryConfig,
} from '../config/index.js';
import { requireGit } from '../git/command.js';
import {
  installHook,
  uninstallHook,
  type HookCommand,
} from '../git/hooks.js';

export type RepositoryDetails = {
  id: string;
  name: string;
  path: string;
  hookPath: string;
};

function expandHome(inputPath: string): string {
  if (inputPath === '~') return homedir();
  if (inputPath.startsWith('~/')) return resolve(homedir(), inputPath.slice(2));
  return resolve(inputPath);
}

export async function inspectRepository(inputPath: string): Promise<RepositoryDetails> {
  const candidate = await realpath(expandHome(inputPath));
  const insideWorkTree = await requireGit(candidate, ['rev-parse', '--is-inside-work-tree']).catch(() => 'false');
  const bare = await requireGit(candidate, ['rev-parse', '--is-bare-repository']).catch(() => 'false');
  if (insideWorkTree !== 'true' && bare !== 'true') throw new Error(`Not a Git repository: ${inputPath}`);
  const repositoryPath = insideWorkTree === 'true'
    ? await realpath(await requireGit(candidate, ['rev-parse', '--show-toplevel']))
    : candidate;
  const hookPath = await requireGit(repositoryPath, [
    'rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push',
  ]);
  const hookRelativePath = relative(repositoryPath, hookPath);
  if (hookRelativePath.startsWith('..') || isAbsolute(hookRelativePath)) {
    throw new Error(`Refusing external or shared core.hooksPath for repository ${repositoryPath}: ${hookPath}`);
  }
  return {
    id: createHash('sha256').update(repositoryPath).digest('hex'),
    name: basename(repositoryPath),
    path: repositoryPath,
    hookPath,
  };
}

export type AddRepositoryOptions = {
  dataDirectory: string;
  nodePath: string;
  runnerPath: string;
  now?: string;
};

function hookCommand(repository: RepositoryDetails, options: AddRepositoryOptions): HookCommand {
  return {
    nodePath: options.nodePath,
    runnerPath: options.runnerPath,
    repositoryId: repository.id,
    repositoryPath: repository.path,
    dataDirectory: options.dataDirectory,
  };
}

export async function addRepository(
  inputPath: string,
  options: AddRepositoryOptions,
): Promise<{ repository: RepositoryConfig; duplicate: boolean; hookStatus: string }> {
  await access(options.runnerPath);
  const details = await inspectRepository(inputPath);
  const config = await loadConfig(options.dataDirectory);
  const existing = config.repositories.find(({ id }) => id === details.id);
  const command = hookCommand(details, options);
  const hookResult = await installHook(details.hookPath, command);
  const repository: RepositoryConfig = {
    ...details,
    hookHash: hookResult.hash,
    addedAt: existing?.addedAt ?? options.now ?? new Date().toISOString(),
  };
  const nextRepositories = existing
    ? config.repositories.map((entry) => entry.id === details.id ? repository : entry)
    : [...config.repositories, repository];

  try {
    await saveConfig({ ...config, repositories: nextRepositories }, options.dataDirectory);
  } catch (error) {
    if (!existing && hookResult.status === 'INSTALLED') {
      await uninstallHook(details.hookPath, hookResult.hash).catch(() => undefined);
    }
    throw error;
  }
  return { repository, duplicate: Boolean(existing), hookStatus: hookResult.status };
}

export async function removeRepository(
  inputPath: string,
  dataDirectory: string,
): Promise<{ removed: boolean; hookStatus: string }> {
  const details = await inspectRepository(inputPath);
  const config = await loadConfig(dataDirectory);
  const existing = config.repositories.find(({ id }) => id === details.id);
  if (!existing) return { removed: false, hookStatus: 'ALREADY_REMOVED' };
  const hookStatus = await uninstallHook(existing.hookPath, existing.hookHash);
  await saveConfig({
    ...config,
    repositories: config.repositories.filter(({ id }) => id !== existing.id),
  }, dataDirectory);
  return { removed: true, hookStatus };
}

export async function updateTimezone(timezone: string, dataDirectory: string): Promise<void> {
  const config = await loadConfig(dataDirectory);
  await saveConfig({ ...config, timezone }, dataDirectory);
}
