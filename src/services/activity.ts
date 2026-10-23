import { createHash } from 'node:crypto';
import { isValidTimeZone, loadConfig } from '../config/index.js';
import { ZERO_SHA } from '../git/types.js';
import { verifyRemoteState } from '../git/verifier.js';
import { JsonEventStore } from '../storage/json-store.js';

function dateInTimeZone(isoTimestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(isoTimestamp));
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function isCalendarDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [year, month, day] = date.split('-').map(Number);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
}

export function createSourceFingerprint(date: string, timezone: string, eventIds: string[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ date, timezone, eventIds: [...eventIds].sort() }))
    .digest('hex');
}

export async function getDailyActivity(date: string, dataDirectory: string, timezoneOverride?: string) {
  if (!isCalendarDate(date)) throw new Error('date must be a real calendar date in YYYY-MM-DD format');
  const config = await loadConfig(dataDirectory);
  const timezone = timezoneOverride ?? config.timezone;
  if (!isValidTimeZone(timezone)) throw new Error('timezone must be a valid IANA timezone');
  const events = (await new JsonEventStore(dataDirectory).read())
    .filter(({ recordedAt }) => dateInTimeZone(recordedAt, timezone) === date)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  const activities = await Promise.all(events.map(async (event) => ({
    eventId: event.id,
    repository: { id: event.repositoryId, name: event.repositoryName },
    attemptedAt: event.recordedAt,
    branch: (ZERO_SHA.test(event.localSha) ? event.remoteRef : event.localRef).replace(/^refs\/heads\//, ''),
    remote: { name: event.remoteName, ref: event.remoteRef },
    commits: event.commits,
    commitsTruncated: event.commitsTruncated,
    verification: await verifyRemoteState(event),
    workInfo: {
      repository: event.repositoryName,
      branch: event.localRef,
      commitSubjects: event.commits.map(({ subject }) => subject),
    },
  })));
  return {
    date,
    timezone,
    sourceFingerprint: createSourceFingerprint(date, timezone, events.map(({ id }) => id)),
    caveat: 'These are pre-push attempts. Remote-state matches do not prove that a particular push command succeeded.',
    activities,
  };
}
