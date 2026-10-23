import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config/index.js';
import { collectPushAttempts } from '../src/git/collector.js';
import { installHook, ModifiedHookError } from '../src/git/hooks.js';
import { redactCommitSubject } from '../src/git/reader.js';
import type { PushAttempt } from '../src/git/types.js';
import { verifyRemoteState } from '../src/git/verifier.js';
import { getDailyActivity } from '../src/services/activity.js';
import { addRepository, inspectRepository, removeRepository } from '../src/services/repositories.js';
import { JsonEventStore } from '../src/storage/json-store.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const sourceRunner = resolve('src/git/hook-runner.ts');
const tsxExecutable = resolve('node_modules/.bin/tsx');

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `local-devlog-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

async function createRepository(parent: string, name = 'repo'): Promise<string> {
  const repository = join(parent, name);
  await mkdir(repository, { recursive: true });
  await git(repository, ['init', '-b', 'main']);
  await git(repository, ['config', 'user.name', 'Test User']);
  await git(repository, ['config', 'user.email', 'test@example.invalid']);
  await writeFile(join(repository, 'README.md'), 'initial\n');
  await git(repository, ['add', 'README.md']);
  await git(repository, ['commit', '-m', 'initial']);
  return repository;
}

async function currentSha(repository: string): Promise<string> {
  return (await git(repository, ['rev-parse', 'HEAD'])).stdout.trim();
}

function testAttempt(overrides: Partial<PushAttempt> = {}): PushAttempt {
  const localSha = '1'.repeat(40);
  const base = {
    repositoryId: '2'.repeat(64),
    repositoryName: 'repo',
    repositoryPath: '/tmp/repo',
    remoteName: 'origin',
    remoteUrl: 'https://example.invalid/repo.git',
    localRef: 'refs/heads/main',
    localSha,
    remoteRef: 'refs/heads/main',
    remoteSha: '0'.repeat(40),
  };
  return {
    id: createHash('sha256').update(JSON.stringify(base)).digest('hex'),
    ...base,
    recordedAt: '2026-10-22T15:30:00.000Z',
    commits: [{ sha: localSha, subject: 'work item', authorName: 'Test User' }],
    commitsTruncated: false,
    ...overrides,
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('repository registration and hooks', () => {
  it('registers multiple repositories, prevents duplicates, and removes only its own hook', async () => {
    const root = await temporaryDirectory('repositories');
    const dataDirectory = join(root, 'data');
    const first = await createRepository(root, 'repo one');
    const second = await createRepository(root, 'repo-two');
    const options = { dataDirectory, nodePath: tsxExecutable, runnerPath: sourceRunner };

    const firstAdd = await addRepository(first, options);
    await addRepository(second, options);
    const duplicate = await addRepository(first, options);
    const config = await loadConfig(dataDirectory);

    expect(firstAdd.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.hookStatus).toBe('ALREADY_INSTALLED');
    expect(config.repositories).toHaveLength(2);

    const hookPath = firstAdd.repository.hookPath;
    await writeFile(hookPath, `${await readFile(hookPath, 'utf8')}# external change\n`);
    await expect(removeRepository(first, dataDirectory)).rejects.toBeInstanceOf(ModifiedHookError);
    expect(await readFile(hookPath, 'utf8')).toContain('external change');
  });

  it('rejects a non-Git path and protects an existing hook', async () => {
    const root = await temporaryDirectory('existing-hook');
    const dataDirectory = join(root, 'data');
    await expect(inspectRepository(root)).rejects.toThrow('Not a Git repository');
    const repository = await createRepository(root);
    const details = await inspectRepository(repository);
    await mkdir(resolve(details.hookPath, '..'), { recursive: true });
    await writeFile(details.hookPath, '#!/bin/sh\necho existing\n', { mode: 0o755 });

    await expect(addRepository(repository, {
      dataDirectory,
      nodePath: tsxExecutable,
      runnerPath: sourceRunner,
    })).rejects.toThrow('Refusing to overwrite existing pre-push hook');
    expect(await readFile(details.hookPath, 'utf8')).toContain('echo existing');
  });

  it('uses the active core.hooksPath and supports idempotent removal', async () => {
    const root = await temporaryDirectory('hooks-path');
    const dataDirectory = join(root, 'data');
    const repository = await createRepository(root);
    await git(repository, ['config', 'core.hooksPath', '.custom-hooks']);

    const added = await addRepository(repository, {
      dataDirectory,
      nodePath: tsxExecutable,
      runnerPath: sourceRunner,
    });
    expect(added.repository.hookPath).toBe(join(added.repository.path, '.custom-hooks', 'pre-push'));
    expect((await readFile(added.repository.hookPath, 'utf8'))).toContain('local-devlog-mcp');

    expect((await removeRepository(repository, dataDirectory)).hookStatus).toBe('REMOVED');
    expect((await removeRepository(repository, dataDirectory)).removed).toBe(false);
  });

  it('refuses an external core.hooksPath that may be shared by repositories', async () => {
    const root = await temporaryDirectory('shared-hooks');
    const repository = await createRepository(root);
    const sharedHooks = join(root, 'shared-hooks');
    await git(repository, ['config', 'core.hooksPath', sharedHooks]);
    await expect(inspectRepository(repository)).rejects.toThrow('Refusing external or shared core.hooksPath');
  });

  it('registers an empty Git repository without requiring a commit', async () => {
    const root = await temporaryDirectory('empty-repository');
    const repository = join(root, 'empty');
    await mkdir(repository);
    await git(repository, ['init', '-b', 'main']);
    const added = await addRepository(repository, {
      dataDirectory: join(root, 'data'),
      nodePath: tsxExecutable,
      runnerPath: sourceRunner,
    });
    expect(added.repository.path).toContain('/empty');
    expect(added.hookStatus).toBe('INSTALLED');
  });
});

describe('event storage and activity', () => {
  it('redacts common credential forms from commit subjects', () => {
    expect(redactCommitSubject('fix token=super-secret Bearer abc123')).toBe('fix token=[REDACTED] Bearer [REDACTED]');
    expect(redactCommitSubject('remove AKIA1234567890ABCDEF')).toBe('remove [REDACTED]');
  });

  it('deduplicates the same ref update and redacts credentials', async () => {
    const root = await temporaryDirectory('dedupe');
    const repository = await createRepository(root);
    const sha = await currentSha(repository);
    const repositoryId = createHash('sha256').update(repository).digest('hex');
    const input = {
      repositoryId,
      repositoryPath: repository,
      remoteName: 'origin',
      remoteUrl: 'https://user:secret@example.invalid/repo.git?token=bad',
      stdin: `refs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\nrefs/heads/main ${sha} refs/heads/main ${'0'.repeat(40)}\n`,
      dataDirectory: join(root, 'data'),
      recordedAt: '2026-10-23T01:00:00.000Z',
    };

    expect(await collectPushAttempts(input)).toEqual({ added: 1, duplicates: 1 });
    expect(await collectPushAttempts(input)).toEqual({ added: 0, duplicates: 2 });
    const events = await new JsonEventStore(input.dataDirectory).read();
    expect(events).toHaveLength(1);
    expect(events[0]?.remoteUrl).toBe('https://example.invalid/repo.git');
    expect(events[0]?.commits[0]?.subject).toBe('initial');
  });

  it('keeps the previous JSON intact when atomic replacement fails', async () => {
    const root = await temporaryDirectory('write-error');
    const dataDirectory = join(root, 'data');
    const workingStore = new JsonEventStore(dataDirectory);
    await workingStore.append([testAttempt()]);
    const failingStore = new JsonEventStore(dataDirectory, {
      rename: async () => { throw new Error('simulated rename failure'); },
    });
    await expect(failingStore.append([testAttempt({ id: '3'.repeat(64) })])).rejects.toThrow('simulated rename failure');
    expect(await workingStore.read()).toHaveLength(1);
  });

  it('serializes concurrent writers without losing events', async () => {
    const root = await temporaryDirectory('concurrent');
    const store = new JsonEventStore(join(root, 'data'));
    await Promise.all([
      store.append([testAttempt({ id: '4'.repeat(64) })]),
      store.append([testAttempt({ id: '5'.repeat(64), localSha: '5'.repeat(40) })]),
    ]);
    expect((await store.read()).map(({ id }) => id).sort()).toEqual(['4'.repeat(64), '5'.repeat(64)]);
  });

  it('rejects malformed persisted configuration', async () => {
    const root = await temporaryDirectory('bad-config');
    const dataDirectory = join(root, 'data');
    await mkdir(dataDirectory);
    await writeFile(join(dataDirectory, 'config.json'), '{"timezone":42}\n');
    await expect(loadConfig(dataDirectory)).rejects.toThrow('invalid schema');
  });

  it('filters activity by configured timezone and reports remote errors as UNKNOWN', async () => {
    const root = await temporaryDirectory('activity');
    const dataDirectory = join(root, 'data');
    await saveConfig({ version: 1, timezone: 'Asia/Seoul', repositories: [] }, dataDirectory);
    await new JsonEventStore(dataDirectory).append([testAttempt()]);

    const result = await getDailyActivity('2026-10-23', dataDirectory);
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]?.verification.status).toBe('UNKNOWN');
    expect((await getDailyActivity('2026-10-22', dataDirectory)).activities).toHaveLength(0);
    await expect(getDailyActivity('2026-02-30', dataDirectory)).rejects.toThrow('real calendar date');
  });
});

describe('real pre-push collection', () => {
  it('stores successful and rejected attempts without an MCP server and deduplicates retries', async () => {
    const root = await temporaryDirectory('push');
    const dataDirectory = join(root, 'data');
    const remote = join(root, 'remote.git');
    await mkdir(remote);
    await git(remote, ['init', '--bare']);
    await git(remote, ['config', 'receive.denyDeleteCurrent', 'ignore']);
    const repository = await createRepository(root, 'working copy');
    await git(repository, ['remote', 'add', 'origin', remote]);
    const details = await inspectRepository(repository);
    await installHook(details.hookPath, {
      nodePath: tsxExecutable,
      runnerPath: sourceRunner,
      repositoryId: details.id,
      repositoryPath: details.path,
      dataDirectory,
    });

    await git(repository, ['push', '-u', 'origin', 'main']);
    const initialEvent = (await new JsonEventStore(dataDirectory).read())[0]!;
    await git(repository, ['remote', 'set-url', 'origin', join(root, 'different.git')]);
    expect((await verifyRemoteState(initialEvent)).status).toBe('UNKNOWN');
    await git(repository, ['remote', 'set-url', 'origin', remote]);
    await writeFile(join(repository, 'README.md'), 'second\n');
    await git(repository, ['commit', '-am', 'second']);
    const rejectHook = join(remote, 'hooks', 'pre-receive');
    await writeFile(rejectHook, '#!/bin/sh\nexit 1\n');
    await chmod(rejectHook, 0o755);

    await expect(git(repository, ['push', 'origin', 'main'])).rejects.toThrow();
    await expect(git(repository, ['push', 'origin', 'main'])).rejects.toThrow();
    const events = await new JsonEventStore(dataDirectory).read();
    expect(events).toHaveLength(2);

    const firstVerification = await verifyRemoteState(events[0]!);
    const rejectedVerification = await verifyRemoteState(events[1]!);
    expect(firstVerification.status).toBe('REMOTE_MATCH');
    expect(rejectedVerification.status).toBe('REMOTE_MISMATCH');

    await unlink(rejectHook);
    await git(repository, ['push', 'origin', 'main']);
    await git(repository, ['reset', '--hard', 'HEAD~1']);
    await writeFile(join(repository, 'README.md'), 'forced\n');
    await git(repository, ['commit', '-am', 'forced update']);
    await git(repository, ['push', '--force', 'origin', 'main']);
    const afterForce = await new JsonEventStore(dataDirectory).read();
    expect(afterForce).toHaveLength(3);
    expect((await verifyRemoteState(afterForce[2]!)).status).toBe('REMOTE_MATCH');

    await git(repository, ['push', 'origin', ':main']);
    const afterDeletion = await new JsonEventStore(dataDirectory).read();
    expect(afterDeletion).toHaveLength(4);
    expect((await verifyRemoteState(afterDeletion[3]!)).status).toBe('REMOTE_MATCH');
  });

  it('allows a push when the collector process fails', async () => {
    const root = await temporaryDirectory('fail-open');
    const remote = join(root, 'remote.git');
    await mkdir(remote);
    await git(remote, ['init', '--bare']);
    const repository = await createRepository(root);
    await git(repository, ['remote', 'add', 'origin', remote]);
    const details = await inspectRepository(repository);
    await installHook(details.hookPath, {
      nodePath: process.execPath,
      runnerPath: join(root, 'missing-runner.js'),
      repositoryId: details.id,
      repositoryPath: details.path,
      dataDirectory: join(root, 'data'),
    });

    await expect(git(repository, ['push', 'origin', 'main'])).resolves.toBeDefined();
    expect((await git(remote, ['rev-parse', 'refs/heads/main'])).stdout.trim()).toBe(await currentSha(repository));
  });
});
