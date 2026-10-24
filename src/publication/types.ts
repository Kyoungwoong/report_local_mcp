import { z } from 'zod';

export const PublicationItemStatusSchema = z.enum(['PENDING', 'SYNCED', 'FAILED']);
export const PublicationKindSchema = z.enum(['WORK_LOG', 'TASK']);

export const PublicationItemStateSchema = z.object({
  localId: z.string().min(1),
  kind: PublicationKindSchema,
  sourceIndex: z.number().int().nonnegative(),
  status: PublicationItemStatusSchema,
  attempts: z.number().int().nonnegative(),
  externalId: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  updatedAt: z.string().datetime(),
});

export const NotionPublicationRecordSchema = z.object({
  draftId: z.string().uuid(),
  draftVersion: z.number().int().positive(),
  selectedNextActionIndexes: z.array(z.number().int().nonnegative()),
  lastPreviewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(PublicationItemStateSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type PublicationItemStatus = z.infer<typeof PublicationItemStatusSchema>;
export type PublicationKind = z.infer<typeof PublicationKindSchema>;
export type PublicationItemState = z.infer<typeof PublicationItemStateSchema>;
export type NotionPublicationRecord = z.infer<typeof NotionPublicationRecordSchema>;

