import {
  formatCalendarDate,
  formatDate,
  formatDateTime,
  formatRelative,
  formatShortDateTime,
  normalizeTimeZone,
} from './date-format.js';

// A summer instant so the New York offset is EDT (UTC-4), not EST.
const NOON_UTC = '2026-07-01T12:00:00Z';
// Midnight UTC — the shape a calendar-day value is stored as.
const MIDNIGHT_UTC = '2026-07-01T00:00:00Z';

describe('formatDateTime', () => {
  it('renders the same instant in each viewer timezone', () => {
    expect(formatDateTime(NOON_UTC, 'UTC')).toBe('Jul 1, 2026, 12:00 PM');
    expect(formatDateTime(NOON_UTC, 'America/New_York')).toBe(
      'Jul 1, 2026, 08:00 AM',
    );
    expect(formatDateTime(NOON_UTC, 'Asia/Kolkata')).toBe(
      'Jul 1, 2026, 05:30 PM',
    );
  });

  it('accepts a Date as well as an ISO string', () => {
    expect(formatDateTime(new Date(NOON_UTC), 'UTC')).toBe(
      'Jul 1, 2026, 12:00 PM',
    );
  });

  it('falls back to UTC for an invalid timezone instead of throwing', () => {
    expect(formatDateTime(NOON_UTC, 'Bogus/Zone')).toBe('Jul 1, 2026, 12:00 PM');
  });

  it('returns the placeholder for nullish / unparseable input', () => {
    expect(formatDateTime(null, 'UTC')).toBe('—');
    expect(formatDateTime(undefined, 'UTC')).toBe('—');
    expect(formatDateTime('not a date', 'UTC')).toBe('—');
  });
});

describe('formatShortDateTime', () => {
  it('drops the year and uses a numeric hour', () => {
    expect(formatShortDateTime(NOON_UTC, 'UTC')).toBe('Jul 1, 12:00 PM');
    expect(formatShortDateTime(NOON_UTC, 'America/New_York')).toBe(
      'Jul 1, 8:00 AM',
    );
  });
});

describe('formatDate vs formatCalendarDate', () => {
  it('formatDate shifts an instant into the viewer zone (can roll the day back)', () => {
    // Midnight UTC is the previous evening in New York, so the DAY changes.
    expect(formatDate(MIDNIGHT_UTC, 'UTC')).toBe('Jul 1, 2026');
    expect(formatDate(MIDNIGHT_UTC, 'America/New_York')).toBe('Jun 30, 2026');
  });

  it('formatCalendarDate pins UTC so the day never shifts', () => {
    expect(formatCalendarDate(MIDNIGHT_UTC)).toBe('Jul 1, 2026');
    // Same output regardless of the ambient/viewer zone.
    expect(formatCalendarDate(new Date(MIDNIGHT_UTC))).toBe('Jul 1, 2026');
  });

  it('returns the placeholder for nullish input', () => {
    expect(formatDate(null, 'UTC')).toBe('—');
    expect(formatCalendarDate(undefined)).toBe('—');
  });
});

describe('normalizeTimeZone', () => {
  it('passes through a valid IANA zone', () => {
    expect(normalizeTimeZone('America/New_York')).toBe('America/New_York');
  });

  it('falls back to UTC for null, empty, or invalid zones', () => {
    expect(normalizeTimeZone(null)).toBe('UTC');
    expect(normalizeTimeZone(undefined)).toBe('UTC');
    expect(normalizeTimeZone('')).toBe('UTC');
    expect(normalizeTimeZone('Not/AZone')).toBe('UTC');
  });
});

describe('formatRelative', () => {
  const now = Date.parse(NOON_UTC);
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it('buckets recent instants deterministically against the passed now', () => {
    expect(formatRelative(ago(30_000), now, 'UTC')).toBe('just now');
    expect(formatRelative(ago(5 * 60_000), now, 'UTC')).toBe('5m ago');
    expect(formatRelative(ago(3 * 3_600_000), now, 'UTC')).toBe('3h ago');
    expect(formatRelative(ago(2 * 86_400_000), now, 'UTC')).toBe('2d ago');
  });

  it('falls back to an absolute date for future or >7-day-old instants', () => {
    expect(formatRelative(ago(10 * 86_400_000), now, 'UTC')).toBe(
      formatDateTime(ago(10 * 86_400_000), 'UTC'),
    );
    expect(formatRelative(new Date(now + 60_000).toISOString(), now, 'UTC')).toBe(
      formatDateTime(new Date(now + 60_000).toISOString(), 'UTC'),
    );
  });

  it('returns the placeholder for nullish input', () => {
    expect(formatRelative(null, now, 'UTC')).toBe('—');
  });
});
