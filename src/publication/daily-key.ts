export function dailyPublicationKey(workDate: string, timezone: string): string {
  return `local-devlog:daily:${workDate}:${encodeURIComponent(timezone)}`;
}

export function dailyWorkLogLocalId(workDate: string, timezone: string): string {
  return `${dailyPublicationKey(workDate, timezone)}:work-log`;
}

export function dailyCalendarLocalId(workDate: string, timezone: string): string {
  return `${dailyPublicationKey(workDate, timezone)}:calendar`;
}

export function isDailyWorkLogLocalId(localId: string): boolean {
  return /^local-devlog:daily:\d{4}-\d{2}-\d{2}:.+:work-log$/.test(localId);
}
