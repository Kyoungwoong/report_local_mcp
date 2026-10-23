import { z } from 'zod';

export const ZERO_SHA = /^0{40,64}$/;

export const PushCommitSchema = z.object({
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  subject: z.string(),
  authorName: z.string(),
});

export const PushAttemptSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  repositoryId: z.string().regex(/^[0-9a-f]{64}$/),
  repositoryName: z.string().min(1),
  repositoryPath: z.string().min(1),
  remoteName: z.string().min(1),
  remoteUrl: z.string(),
  localRef: z.string().min(1),
  localSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  remoteRef: z.string().min(1),
  remoteSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  recordedAt: z.string().datetime(),
  commits: z.array(PushCommitSchema),
  commitsTruncated: z.boolean(),
});

export type PushCommit = z.infer<typeof PushCommitSchema>;
export type PushAttempt = z.infer<typeof PushAttemptSchema>;

export type RemoteVerification = {
  status: 'REMOTE_MATCH' | 'REMOTE_MISMATCH' | 'UNKNOWN';
  observedSha?: string;
  reason: string;
  checkedAt: string;
};
