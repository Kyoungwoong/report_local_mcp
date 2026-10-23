export type ApprovedDailyLog = { id: string; date: string; summary: string; approvedVersion: number };
export type PublishResult = { target: string; status: 'SYNCED' | 'FAILED'; externalId?: string };
export interface OutputAdapter {
  readonly name: string;
  publish(log: ApprovedDailyLog): Promise<PublishResult>;
}
