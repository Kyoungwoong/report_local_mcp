import { describe, expect, it } from 'vitest';
import {
  createApprovalArguments,
  createUpdateArguments,
  isVersionConflict,
  parsePayload,
  type Draft,
} from '../app/model.js';

const draft: Draft = {
  draftId: '11111111-1111-4111-8111-111111111111',
  workDate: '2026-10-23',
  timezone: 'Asia/Seoul',
  summary: 'Summary',
  workItems: [],
  nextActions: [],
  sourceEventIds: ['a'.repeat(64)],
  sourceFingerprint: 'b'.repeat(64),
  version: 4,
  status: 'PENDING',
  updatedAt: '2026-10-23T00:00:00.000Z',
  approvedAt: null,
  approvalMethod: null,
  approvalWarnings: [],
};

describe('MCP App state helpers', () => {
  it('parses structured draft and list results but rejects malformed payloads', () => {
    expect(parsePayload({ ok: true, draft, revisions: [draft] })).toEqual({ ok: true, draft, revisions: [draft] });
    expect(parsePayload({ ok: true, drafts: [draft] })).toEqual({ ok: true, drafts: [draft] });
    expect(parsePayload({ ok: true, draft: { draftId: 42 }, revisions: [] })).toBeUndefined();
  });

  it('uses the displayed version for edits, rejection, reopening, and approval', () => {
    const edits = { summary: 'Edited', workItems: [], nextActions: ['Next'] };
    expect(createUpdateArguments(draft, edits, 'PENDING')).toMatchObject({
      draftId: draft.draftId, expectedVersion: 4, status: 'PENDING', summary: 'Edited',
    });
    expect(createUpdateArguments(draft, edits, 'REJECTED')).toMatchObject({ expectedVersion: 4, status: 'REJECTED' });
    expect(createApprovalArguments(draft, 'exact')).toEqual({ draftId: draft.draftId, version: 4, confirmation: 'exact' });
    expect(isVersionConflict({ code: 'VERSION_CONFLICT' })).toBe(true);
  });
});
