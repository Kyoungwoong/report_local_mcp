import { execFile } from 'node:child_process';

export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export function runGit(
  repositoryPath: string,
  args: string[],
  options: { timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: repositoryPath,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeoutMs ?? 5_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      const exitCode = typeof error?.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

export async function requireGit(repositoryPath: string, args: string[]): Promise<string> {
  const result = await runGit(repositoryPath, args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0] ?? ''} failed`);
  }
  return result.stdout.trim();
}
