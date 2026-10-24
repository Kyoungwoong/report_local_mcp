import { z } from 'zod';

export const CalendarPublicationStatusSchema = z.enum(['PENDING', 'SYNCED', 'FAILED']);

export const CalendarPublicationRecordSchema = z.object({
  draftId: z.string().uuid(),
  draftVersion: z.number().int().positive(),
  localId: z.string().min(1),
  previewFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  calendarIdentifier: z.string().min(1),
  workDate: z.string().min(1),
  timezone: z.string().min(1).optional(),
  dailyKey: z.string().min(1).optional(),
  status: CalendarPublicationStatusSchema,
  attempts: z.number().int().nonnegative(),
  eventIdentifier: z.string().min(1).optional(),
  errorCode: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CalendarPublicationRecord = z.infer<typeof CalendarPublicationRecordSchema>;
