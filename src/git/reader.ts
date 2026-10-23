import { runGit } from './command.js';
import { ZERO_SHA, type PushCommit } from './types.js';

const MAX_COMMITS = 50;

export function sanitizeRemoteUrl(remoteUrl: string): string {
  try {
    const parsed = new URL(remoteUrl);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return remoteUrl.replace(/^(https?:\/\/)[^/@\s]+@/i, '$1').replace(/[?#].*$/, '');
  }
}

export function redactCommitSubject(subject: string): string {
  return subject
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\b(token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

export async function readPushedCommits(
  repositoryPath: string,
  localSha: string,
  remoteSha: string,
): Promise<{ commits: PushCommit[]; truncated: boolean }> {
  if (ZERO_SHA.test(localSha)) return { commits: [], truncated: false };
  const revision = ZERO_SHA.test(remoteSha) ? localSha : `${remoteSha}..${localSha}`;
  const result = await runGit(repositoryPath, [
    'log',
    `--max-count=${MAX_COMMITS + 1}`,
    '--format=%H%x1f%s%x1f%an%x1e',
    revision,
  ]);
  if (result.exitCode !== 0) {
    const fallback = await runGit(repositoryPath, [
      'show', '-s', '--format=%H%x1f%s%x1f%an%x1e', localSha,
    ]);
    if (fallback.exitCode !== 0) return { commits: [], truncated: false };
    return { commits: parseCommits(fallback.stdout).slice(0, 1), truncated: false };
  }
  const parsed = parseCommits(result.stdout);
  return { commits: parsed.slice(0, MAX_COMMITS), truncated: parsed.length > MAX_COMMITS };
}

function parseCommits(output: string): PushCommit[] {
  return output.split('\x1e').flatMap((record) => {
    const cleaned = record.trim();
    if (!cleaned) return [];
    const [sha, subject, authorName] = cleaned.split('\x1f');
    if (!sha || subject === undefined || authorName === undefined) return [];
    return [{ sha, subject: redactCommitSubject(subject), authorName }];
  });
}
