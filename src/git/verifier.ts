import { runGit } from './command.js';
import { sanitizeRemoteUrl } from './reader.js';
import { ZERO_SHA, type PushAttempt, type RemoteVerification } from './types.js';

export async function verifyRemoteState(attempt: PushAttempt): Promise<RemoteVerification> {
  const checkedAt = new Date().toISOString();
  const configuredRemote = await runGit(attempt.repositoryPath, [
    'remote', 'get-url', attempt.remoteName,
  ]);
  if (configuredRemote.exitCode !== 0) {
    return { status: 'UNKNOWN', reason: 'The recorded remote is no longer configured in the repository.', checkedAt };
  }
  if (sanitizeRemoteUrl(configuredRemote.stdout.trim()) !== attempt.remoteUrl) {
    return { status: 'UNKNOWN', reason: 'The configured remote URL has changed since the push attempt.', checkedAt };
  }
  const result = await runGit(attempt.repositoryPath, [
    'ls-remote', '--refs', attempt.remoteName, attempt.remoteRef,
  ], { timeoutMs: 5_000 });
  if (result.exitCode !== 0) {
    return { status: 'UNKNOWN', reason: 'Remote lookup failed or timed out.', checkedAt };
  }

  const matchingLine = result.stdout.split(/\r?\n/).find((line) => line.endsWith(`\t${attempt.remoteRef}`));
  const observedSha = matchingLine?.split(/\s+/)[0];
  const deletionRequested = ZERO_SHA.test(attempt.localSha);

  if (!observedSha) {
    return deletionRequested
      ? { status: 'REMOTE_MATCH', reason: 'The requested ref is currently absent; this does not prove which push removed it.', checkedAt }
      : { status: 'REMOTE_MISMATCH', reason: 'The requested remote ref is absent.', checkedAt };
  }
  if (deletionRequested) {
    return { status: 'REMOTE_MISMATCH', observedSha, reason: 'The requested deletion is not reflected by the current remote ref.', checkedAt };
  }
  if (observedSha === attempt.localSha) {
    return { status: 'REMOTE_MATCH', observedSha, reason: 'The current remote ref matches the attempted local SHA; this is not proof that this push command succeeded.', checkedAt };
  }
  if (!ZERO_SHA.test(attempt.remoteSha) && observedSha === attempt.remoteSha) {
    return { status: 'REMOTE_MISMATCH', observedSha, reason: 'The remote ref remains at the SHA observed before the push attempt.', checkedAt };
  }
  if (!attempt.remoteRef.startsWith('refs/heads/')) {
    return { status: 'REMOTE_MISMATCH', observedSha, reason: 'The current remote ref points to a different object.', checkedAt };
  }

  const ancestry = await runGit(attempt.repositoryPath, [
    'merge-base', '--is-ancestor', attempt.localSha, observedSha,
  ]);
  if (ancestry.exitCode === 0) {
    return { status: 'REMOTE_MATCH', observedSha, reason: 'The attempted commit is reachable from the current remote branch; this does not prove which push introduced it.', checkedAt };
  }
  const objectKnown = await runGit(attempt.repositoryPath, ['cat-file', '-e', `${observedSha}^{commit}`]);
  if (objectKnown.exitCode === 0) {
    return { status: 'REMOTE_MISMATCH', observedSha, reason: 'The known current remote commit does not contain the attempted commit.', checkedAt };
  }
  return { status: 'UNKNOWN', observedSha, reason: 'The remote ref changed, but its commit is not available locally for ancestry verification.', checkedAt };
}
