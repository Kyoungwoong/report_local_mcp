import { z } from 'zod';
import { isValidTimeZone } from '../config/index.js';
import { isCalendarDate } from '../services/activity.js';

export const DraftStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED']);
export const WorkItemVerificationSchema = z.enum(['REMOTE_MATCH', 'UNCONFIRMED']);
export const ApprovalMethodSchema = z.enum(['MCP_ELICITATION', 'EXPLICIT_CONFIRMATION_FALLBACK']);
export const ApprovalWarningSchema = z.enum(['SOURCE_CHANGED_AFTER_DRAFT']);

export const DraftWorkItemInputSchema = z.object({
  repositoryId: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().min(1).max(500),
  details: z.string().max(10_000),
  sourceEventIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
});

export const DraftWorkItemSchema = DraftWorkItemInputSchema.extend({
  verificationStatus: WorkItemVerificationSchema,
});

export const DraftContentInputSchema = z.object({
  summary: z.string().min(1).max(20_000),
  workItems: z.array(DraftWorkItemInputSchema).min(1).max(100),
  nextActions: z.array(z.string().min(1).max(1_000)).max(100),
  sourceEventIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

export const DailyDraftSchema = z.object({
  draftId: z.string().uuid(),
  workDate: z.string().refine(isCalendarDate, 'Expected a real YYYY-MM-DD calendar date'),
  timezone: z.string().refine(isValidTimeZone, 'Expected a valid IANA timezone'),
  summary: z.string().min(1).max(20_000),
  workItems: z.array(DraftWorkItemSchema).min(1).max(100),
  nextActions: z.array(z.string().min(1).max(1_000)).max(100),
  sourceEventIds: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
  sourceFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  version: z.number().int().positive(),
  status: DraftStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  approvedAt: z.string().datetime().nullable(),
  approvedVersion: z.number().int().positive().nullable(),
  approvalMethod: ApprovalMethodSchema.nullable(),
  approvalWarnings: z.array(ApprovalWarningSchema),
}).superRefine((draft, context) => {
  const approved = draft.status === 'APPROVED';
  if (approved !== (draft.approvedAt !== null && draft.approvedVersion !== null && draft.approvalMethod !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Approval metadata must exist only on approved drafts' });
  }
  if (approved && draft.approvedVersion !== draft.version) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'approvedVersion must equal the immutable draft version' });
  }
  if (!approved && draft.approvalWarnings.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Approval warnings require an approved draft' });
  }
});

export const DraftRecordSchema = z.object({
  draftId: z.string().uuid(),
  workDate: z.string().refine(isCalendarDate),
  timezone: z.string().refine(isValidTimeZone),
  revisions: z.array(DailyDraftSchema).min(1),
}).superRefine((record, context) => {
  record.revisions.forEach((revision, index) => {
    if (revision.draftId !== record.draftId || revision.workDate !== record.workDate || revision.timezone !== record.timezone) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['revisions', index], message: 'Revision identity must match its draft record' });
    }
    if (revision.version !== index + 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['revisions', index, 'version'], message: 'Revision versions must be contiguous' });
    }
    if (revision.status === 'APPROVED' && index !== record.revisions.length - 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['revisions', index, 'status'], message: 'Only the latest revision may be approved' });
    }
  });
});

export type DraftStatus = z.infer<typeof DraftStatusSchema>;
export type DraftWorkItemInput = z.infer<typeof DraftWorkItemInputSchema>;
export type DraftWorkItem = z.infer<typeof DraftWorkItemSchema>;
export type DraftContentInput = z.infer<typeof DraftContentInputSchema>;
export type DailyDraft = z.infer<typeof DailyDraftSchema>;
export type DraftRecord = z.infer<typeof DraftRecordSchema>;
export type ApprovalMethod = z.infer<typeof ApprovalMethodSchema>;

