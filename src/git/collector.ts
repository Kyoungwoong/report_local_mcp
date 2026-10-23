import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { JsonEventStore } from '../storage/json-store.js';
import { readPushedCommits, sanitizeRemoteUrl } from './reader.js';
import type { PushAttempt } from './types.js';

const REF_UPDATE_PATTERN = /^(\S+)\s+([0-9a-f]{40,64})\s+(\S+)\s+([0-9a-f]{40,64})$/;

export type CollectPushInput = {
  repositoryId: string;
  repositoryPath: string;
  remoteName: string;
  remoteUrl: string;
  stdin: string;
  dataDirectory: string;
  recordedAt?: string;
};

function createEventId(fields: Omit<PushAttempt, 'id' | 'recordedAt' | 'commits' | 'commitsTruncated'>): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

export async function collectPushAttempts(input: CollectPushInput): Promise<{ added: number; duplicates: number }> {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const remoteUrl = sanitizeRemoteUrl(input.remoteUrl);
  const repositoryName = basename(input.repositoryPath);
  const attempts: PushAttempt[] = [];

  for (const line of input.stdin.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = REF_UPDATE_PATTERN.exec(line.trim());
    if (!match) throw new Error('Malformed pre-push input');
    const [, localRef, localSha, remoteRef, remoteSha] = match;
    const commitResult = await readPushedCommits(input.repositoryPath, localSha, remoteSha);
    const identity = {
      repositoryId: input.repositoryId,
      repositoryName,
      repositoryPath: input.repositoryPath,
      remoteName: input.remoteName,
      remoteUrl,
      localRef,
      localSha,
      remoteRef,
      remoteSha,
    };
    attempts.push({
      id: createEventId(identity),
      ...identity,
      recordedAt,
      commits: commitResult.commits,
      commitsTruncated: commitResult.truncated,
    });
  }

  if (attempts.length === 0) return { added: 0, duplicates: 0 };
  return new JsonEventStore(input.dataDirectory).append(attempts);
}
