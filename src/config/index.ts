export type AppConfig = {
  timezone: string;
  repositories: string[];
  calendar: { enabled: boolean; name: string };
  notion: { enabled: boolean };
};
