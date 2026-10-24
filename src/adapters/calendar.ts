import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../config/index.js';

export type CalendarAdapterErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'BRIDGE_NOT_BUILT'
  | 'BRIDGE_PROTOCOL_ERROR'
  | 'PERMISSION_NOT_DETERMINED'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_RESTRICTED'
  | 'FULL_ACCESS_REQUIRED'
  | 'CALENDAR_NOT_CONFIGURED'
  | 'CALENDAR_NOT_FOUND'
  | 'CALENDAR_NOT_WRITABLE'
  | 'EVENTKIT_READ_FAILED'
  | 'EVENTKIT_SAVE_FAILED';

export class CalendarAdapterError extends Error {
  constructor(readonly code: CalendarAdapterErrorCode, message: string) {
    super(message);
    this.name = 'CalendarAdapterError';
  }
}

export const CalendarInfoSchema = z.object({
  identifier: z.string().min(1),
  title: z.string().min(1),
  sourceTitle: z.string().min(1),
  allowsContentModifications: z.boolean(),
});

const AuthorizationSchema = z.enum([
  'NOT_DETERMINED', 'RESTRICTED', 'DENIED', 'FULL_ACCESS', 'WRITE_ONLY', 'UNKNOWN',
]);
const ValidateResultSchema = z.object({
  authorizationStatus: AuthorizationSchema,
  calendars: z.array(CalendarInfoSchema),
});
const LookupResultSchema = z.object({
  status: z.enum(['MATCH', 'MISSING', 'MOVED', 'CONFLICT']),
  eventIdentifier: z.string().min(1).optional(),
  calendarIdentifier: z.string().min(1).optional(),
  existingLocalId: z.string().min(1).optional(),
});
const CreateResultSchema = z.object({ eventIdentifier: z.string().min(1) });
const BridgeResponseSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
});

export type CalendarInfo = z.infer<typeof CalendarInfoSchema>;
export type CalendarConnectionValidation = {
  platform: 'darwin';
  authorizationStatus: z.infer<typeof AuthorizationSchema>;
  configurationPresent: boolean;
  configured: CalendarInfo | null;
  calendars: CalendarInfo[];
  valid: boolean;
};
export type CalendarEventInput = {
  calendarIdentifier: string;
  localId: string;
  workDate: string;
  timezone: string;
  title: string;
  notes: string;
};
export type CalendarEventLookup = z.infer<typeof LookupResultSchema>;

type BridgeRequest = Record<string, unknown> & { action: string };
export type CalendarBridgeRunner = (request: BridgeRequest) => Promise<unknown>;

function defaultBridgePath(): string {
  const packageRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  return resolve(packageRoot, 'dist/native/LocalDevLogCalendarBridge.app/Contents/MacOS/LocalDevLogCalendarBridge');
}

function processRunner(binaryPath = defaultBridgePath()): CalendarBridgeRunner {
  return (request) => new Promise((resolvePromise, reject) => {
    if (process.platform !== 'darwin') {
      reject(new CalendarAdapterError('UNSUPPORTED_PLATFORM', 'Apple Calendar integration requires macOS'));
      return;
    }
    const child = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      operation();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(() => reject(new CalendarAdapterError('BRIDGE_PROTOCOL_ERROR', 'Calendar bridge timed out')));
    }, request.requestPermission === true ? 120_000 : 15_000);
    child.on('error', (error) => finish(() => reject(new CalendarAdapterError(
      'code' in error && error.code === 'ENOENT' ? 'BRIDGE_NOT_BUILT' : 'BRIDGE_PROTOCOL_ERROR',
      'Calendar bridge could not be started',
    ))));
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize <= 1_000_000) stdout.push(chunk);
      else child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize <= 64_000) stderr.push(chunk);
    });
    child.on('close', () => finish(() => {
      try {
        if (stdoutSize > 1_000_000) throw new Error('Calendar bridge response was too large');
        resolvePromise(JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown);
      } catch {
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
        reject(new CalendarAdapterError(
          'BRIDGE_PROTOCOL_ERROR',
          diagnostic ? `Calendar bridge returned invalid JSON: ${diagnostic.slice(0, 500)}` : 'Calendar bridge returned invalid JSON',
        ));
      }
    }));
    child.stdin.end(JSON.stringify(request));
  });
}

export interface CalendarPort {
  validateConnection(requestPermission?: boolean): Promise<CalendarConnectionValidation>;
  listCalendars(requestPermission?: boolean): Promise<CalendarInfo[]>;
  findEvent(input: CalendarEventInput, knownEventIdentifier?: string): Promise<CalendarEventLookup>;
  createEvent(input: CalendarEventInput): Promise<string>;
}

export class CalendarAdapter implements CalendarPort {
  constructor(
    private readonly dataDirectory: string,
    private readonly runBridge: CalendarBridgeRunner = processRunner(),
  ) {}

  private async request<T>(request: BridgeRequest, schema: z.ZodType<T>): Promise<T> {
    const envelope = BridgeResponseSchema.safeParse(await this.runBridge(request));
    if (!envelope.success) throw new CalendarAdapterError('BRIDGE_PROTOCOL_ERROR', 'Calendar bridge response was invalid');
    if (!envelope.data.ok) {
      const code = envelope.data.code as CalendarAdapterErrorCode | undefined;
      throw new CalendarAdapterError(code ?? 'BRIDGE_PROTOCOL_ERROR', envelope.data.message ?? 'Calendar bridge failed');
    }
    const result = schema.safeParse(envelope.data.result);
    if (!result.success) throw new CalendarAdapterError('BRIDGE_PROTOCOL_ERROR', 'Calendar bridge result was invalid');
    return result.data;
  }

  private rawValidation(requestPermission: boolean) {
    return this.request({ action: 'validate', requestPermission }, ValidateResultSchema);
  }

  async validateConnection(requestPermission = false): Promise<CalendarConnectionValidation> {
    const raw = await this.rawValidation(requestPermission);
    const configuredCalendar = (await loadConfig(this.dataDirectory)).calendar;
    const configured = configuredCalendar
      ? raw.calendars.find(({ identifier }) => identifier === configuredCalendar.identifier) ?? null
      : null;
    return {
      platform: 'darwin',
      authorizationStatus: raw.authorizationStatus,
      configurationPresent: configuredCalendar !== undefined,
      configured,
      calendars: raw.calendars,
      valid: raw.authorizationStatus === 'FULL_ACCESS'
        && configured !== null
        && configured.allowsContentModifications,
    };
  }

  async listCalendars(requestPermission = false): Promise<CalendarInfo[]> {
    return (await this.rawValidation(requestPermission)).calendars;
  }

  async findEvent(input: CalendarEventInput, knownEventIdentifier?: string): Promise<CalendarEventLookup> {
    return this.request({ action: 'find', ...input, knownEventIdentifier }, LookupResultSchema);
  }

  async createEvent(input: CalendarEventInput): Promise<string> {
    return (await this.request({ action: 'create', ...input }, CreateResultSchema)).eventIdentifier;
  }
}
