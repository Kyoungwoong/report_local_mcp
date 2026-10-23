export type WorkItem = {
  repositoryId: string;
  title: string;
  details: string;
  sourceEventIds: string[];
  verificationStatus?: string;
};

export type Draft = {
  draftId: string;
  workDate: string;
  timezone: string;
  summary: string;
  workItems: WorkItem[];
  nextActions: string[];
  sourceEventIds: string[];
  sourceFingerprint: string;
  version: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  updatedAt: string;
  approvedAt: string | null;
  approvalMethod: string | null;
  approvalWarnings: string[];
};

export type DraftPayload = { ok: true; draft: Draft; revisions: Draft[] };
export type ListPayload = { ok: true; drafts: Draft[] };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isDraft(value: unknown): value is Draft {
  return isRecord(value)
    && typeof value.draftId === 'string'
    && typeof value.workDate === 'string'
    && typeof value.timezone === 'string'
    && typeof value.summary === 'string'
    && Array.isArray(value.workItems)
    && Array.isArray(value.nextActions)
    && Array.isArray(value.sourceEventIds)
    && typeof value.sourceFingerprint === 'string'
    && typeof value.version === 'number'
    && (value.status === 'PENDING' || value.status === 'APPROVED' || value.status === 'REJECTED')
    && typeof value.updatedAt === 'string'
    && Array.isArray(value.approvalWarnings);
}

export function parsePayload(value: unknown): DraftPayload | ListPayload | undefined {
  if (!isRecord(value) || value.ok !== true) return undefined;
  if (Array.isArray(value.drafts) && value.drafts.every(isDraft)) return { ok: true, drafts: value.drafts };
  if (isDraft(value.draft) && Array.isArray(value.revisions) && value.revisions.every(isDraft)) {
    return { ok: true, draft: value.draft, revisions: value.revisions };
  }
  return undefined;
}

export function createUpdateArguments(
  draft: Draft,
  edits: { summary: string; workItems: unknown[]; nextActions: string[] },
  status: 'PENDING' | 'REJECTED',
): Record<string, unknown> {
  return {
    draftId: draft.draftId,
    expectedVersion: draft.version,
    status,
    ...edits,
    sourceEventIds: draft.sourceEventIds,
    sourceFingerprint: draft.sourceFingerprint,
  };
}

export function createApprovalArguments(draft: Draft, confirmation?: string): Record<string, unknown> {
  return { draftId: draft.draftId, version: draft.version, confirmation };
}

export function isVersionConflict(value: unknown): boolean {
  return isRecord(value) && value.code === 'VERSION_CONFLICT';
}

