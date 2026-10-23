// Milestone 1: capture Git pre-push ATTEMPTS, not confirmed pushes.
export type PushAttempt = { repositoryPath: string; recordedAt: string; verification: 'UNVERIFIED' | 'VERIFIED' };
