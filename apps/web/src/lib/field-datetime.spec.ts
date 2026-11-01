import {
  fieldDateTimeSortKey,
  formatFieldDateTime,
  parseFieldDateTime,
} from './field-datetime';

describe('formatFieldDateTime', () => {
  it('shows a zone-less value as entered, whatever the viewer zone', () => {
    // What the asset forms save from a `datetime-local` input.
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      expect(formatFieldDateTime('2026-07-01T15:00', tz)).toBe('Jul 1, 2026, 03:00 PM');
      expect(formatFieldDateTime('2026-07-01T15:00:30.250', tz)).toBe('Jul 1, 2026, 03:00 PM');
    }
  });

  it('shows a zoned value in the viewer zone', () => {
    expect(formatFieldDateTime('2026-07-01T15:00:00.000Z', 'America/Los_Angeles')).toBe(
      'Jul 1, 2026, 08:00 AM',
    );
    expect(formatFieldDateTime('2026-07-01T15:00+02:00', 'UTC')).toBe('Jul 1, 2026, 01:00 PM');
  });

  it('returns null for values it cannot resolve deterministically', () => {
    expect(formatFieldDateTime('', 'UTC')).toBeNull();
    expect(formatFieldDateTime('not a date', 'UTC')).toBeNull();
    expect(formatFieldDateTime('2026-07-01', 'UTC')).toBeNull();
    expect(formatFieldDateTime('July 1 2026 3:00 PM', 'UTC')).toBeNull();
    expect(formatFieldDateTime('2026-13-45T99:99', 'UTC')).toBeNull();
  });

  describe('fieldDateTimeSortKey', () => {
    // Issue #98 review: mixed formats must sort in the order they DISPLAY.
    // For a Los Angeles viewer `20:00Z` shows as 01:00 PM, so it sorts
    // before the zone-less `15:00` (03:00 PM) despite the later instant.
    const LA = 'America/Los_Angeles';

    it('orders mixed formats by the displayed time', () => {
      const values = ['2026-07-01T15:00', '2026-07-01T20:00:00Z', '2026-07-01T14:59'];
      const sorted = [...values].sort(
        (a, b) => fieldDateTimeSortKey(a, LA)! - fieldDateTimeSortKey(b, LA)!,
      );
      expect(sorted).toEqual(['2026-07-01T20:00:00Z', '2026-07-01T14:59', '2026-07-01T15:00']);
      expect(sorted.map((v) => formatFieldDateTime(v, LA))).toEqual([
        'Jul 1, 2026, 01:00 PM',
        'Jul 1, 2026, 02:59 PM',
        'Jul 1, 2026, 03:00 PM',
      ]);
    });

    it('keys an instant on its wall-clock fields in the viewer zone', () => {
      expect(fieldDateTimeSortKey('2026-07-01T20:00:00Z', LA)).toBe(
        Date.UTC(2026, 6, 1, 13, 0, 0),
      );
      expect(fieldDateTimeSortKey('2026-07-01T20:00:00.250+02:00', 'Asia/Tokyo')).toBe(
        Date.UTC(2026, 6, 2, 3, 0, 0, 250),
      );
      // Midnight in the viewer zone reads 00, never 24.
      expect(fieldDateTimeSortKey('2026-07-01T07:00:00Z', LA)).toBe(Date.UTC(2026, 6, 1, 0, 0, 0));
    });

    it('keys a zone-less value on its own fields, whatever the viewer zone', () => {
      for (const tz of ['UTC', LA, 'Asia/Tokyo']) {
        expect(fieldDateTimeSortKey('2026-07-01T15:00', tz)).toBe(Date.UTC(2026, 6, 1, 15, 0));
      }
    });

    it('returns null for an unresolvable value', () => {
      expect(fieldDateTimeSortKey('not a date', LA)).toBeNull();
    });
  });

  // Issue #98 review: a zone-less value must render the same on the SSR
  // runtime (UTC container) and in the browser (the viewer's local zone),
  // or React hydration mismatches.
  describe('does not depend on the runtime zone', () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original;
    });

    it.each(['UTC', 'America/Los_Angeles', 'Asia/Kolkata'])('runtime %s', (runtimeTz) => {
      process.env.TZ = runtimeTz;
      expect(formatFieldDateTime('2026-07-01T15:00', 'America/Los_Angeles')).toBe(
        'Jul 1, 2026, 03:00 PM',
      );
      expect(formatFieldDateTime('2026-07-01T15:00:00Z', 'America/Los_Angeles')).toBe(
        'Jul 1, 2026, 08:00 AM',
      );
      expect(parseFieldDateTime('2026-07-01T15:00')?.at.toISOString()).toBe(
        '2026-07-01T15:00:00.000Z',
      );
      expect(fieldDateTimeSortKey('2026-07-01T20:00:00Z', 'America/Los_Angeles')).toBe(
        Date.UTC(2026, 6, 1, 13, 0, 0),
      );
    });
  });
});
