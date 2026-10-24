import { describe, expect, it } from 'vitest';
import { CalendarAdapter } from '../src/adapters/calendar.js';
import { getDataDirectory } from '../src/config/index.js';
import { CalendarPublicationService, calendarPublicationPhrase } from '../src/services/calendar-publisher.js';

const runReadOnly = process.env.RUN_CALENDAR_INTEGRATION === '1' ? it : it.skip;
const runWrite = process.env.RUN_CALENDAR_WRITE_INTEGRATION === '1' ? it : it.skip;

describe('opt-in Apple Calendar integration', () => {
  runReadOnly('validates full access and the configured writable Calendar', async () => {
    const adapter = new CalendarAdapter(getDataDirectory());
    await expect(adapter.validateConnection(false)).resolves.toMatchObject({
      platform: 'darwin', authorizationStatus: 'FULL_ACCESS', valid: true,
    });
  });

  runWrite('publishes only the explicitly confirmed real approved draft', async () => {
    const draftId = process.env.CALENDAR_TEST_DRAFT_ID;
    const version = Number(process.env.CALENDAR_TEST_DRAFT_VERSION);
    if (!draftId || !Number.isInteger(version) || version < 1) {
      throw new Error('CALENDAR_TEST_DRAFT_ID and CALENDAR_TEST_DRAFT_VERSION are required');
    }
    const dataDirectory = getDataDirectory();
    const service = new CalendarPublicationService(dataDirectory, new CalendarAdapter(dataDirectory));
    const preview = await service.preview({ draftId, version });
    const phrase = calendarPublicationPhrase(draftId, version, preview.previewFingerprint);
    if (process.env.CALENDAR_PUBLICATION_CONFIRMATION !== phrase) {
      throw new Error(`Explicit confirmation is required: ${phrase}`);
    }
    await expect(service.publish({
      draftId, version, previewFingerprint: preview.previewFingerprint, publicationAuthorized: true,
    })).resolves.toMatchObject({ status: 'SYNCED' });
  });
});
