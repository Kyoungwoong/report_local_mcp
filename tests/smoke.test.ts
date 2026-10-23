import { describe, expect, it } from 'vitest';
import type { ApprovedDailyLog } from '../src/adapters/types.js';
describe('starter contracts', () => {
  it('preserves approved draft version', () => {
    const log: ApprovedDailyLog = { id: 'one', date: '2026-10-21', summary: 'test', approvedVersion: 1 };
    expect(log.approvedVersion).toBe(1);
  });
});
