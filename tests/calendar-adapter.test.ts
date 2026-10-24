import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CalendarAdapter, CalendarAdapterError } from '../src/adapters/calendar.js';
import { saveConfig } from '../src/config/index.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directoryWithCalendar(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'local-devlog-calendar-adapter-'));
  directories.push(directory);
  await saveConfig({
    version: 1,
    timezone: 'Asia/Seoul',
    repositories: [],
    calendar: { identifier: 'calendar-1', title: 'Development', sourceTitle: 'iCloud' },
  }, directory);
  return directory;
}

describe('Calendar adapter', () => {
  it('distinguishes permission states and configured calendar readiness', async () => {
    const directory = await directoryWithCalendar();
    const denied = new CalendarAdapter(directory, async () => ({
      ok: true,
      result: { authorizationStatus: 'DENIED', calendars: [] },
    }));
    await expect(denied.validateConnection()).resolves.toMatchObject({
      authorizationStatus: 'DENIED', configurationPresent: true, configured: null, valid: false,
    });

    const ready = new CalendarAdapter(directory, async () => ({
      ok: true,
      result: {
        authorizationStatus: 'FULL_ACCESS',
        calendars: [{
          identifier: 'calendar-1', title: 'Development', sourceTitle: 'iCloud', allowsContentModifications: true,
        }],
      },
    }));
    await expect(ready.validateConnection()).resolves.toMatchObject({
      authorizationStatus: 'FULL_ACCESS', valid: true, configured: { identifier: 'calendar-1' },
    });
  });

  it('keeps Calendar absence and read-only errors distinguishable', async () => {
    const directory = await directoryWithCalendar();
    const missing = new CalendarAdapter(directory, async () => ({
      ok: false, code: 'CALENDAR_NOT_FOUND', message: 'missing',
    }));
    await expect(missing.findEvent({
      calendarIdentifier: 'calendar-1', localId: 'local', workDate: '2026-10-24',
      timezone: 'Asia/Seoul', title: 'title', notes: 'notes',
    })).rejects.toEqual(new CalendarAdapterError('CALENDAR_NOT_FOUND', 'missing'));

    const readOnly = new CalendarAdapter(directory, async () => ({
      ok: false, code: 'CALENDAR_NOT_WRITABLE', message: 'read only',
    }));
    await expect(readOnly.createEvent({
      calendarIdentifier: 'calendar-1', localId: 'local', workDate: '2026-10-24',
      timezone: 'Asia/Seoul', title: 'title', notes: 'notes',
    })).rejects.toMatchObject({ code: 'CALENDAR_NOT_WRITABLE' });
  });
});
