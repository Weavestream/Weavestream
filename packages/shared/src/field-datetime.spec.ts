import { parseExpiryInstant, parseFieldDateTime } from './field-datetime.js';

describe('parseFieldDateTime', () => {
  it('reads a zone-less value as its wall-clock fields in UTC', () => {
    const parsed = parseFieldDateTime('2026-07-01T15:00');
    expect(parsed?.kind).toBe('wall-clock');
    expect(parsed?.at.toISOString()).toBe('2026-07-01T15:00:00.000Z');
    expect(parseFieldDateTime('2026-07-01T15:00:30.250')?.at.toISOString()).toBe(
      '2026-07-01T15:00:30.250Z',
    );
  });

  it('reads a zoned value as the instant it names', () => {
    const parsed = parseFieldDateTime('2026-07-01T15:00+02:00');
    expect(parsed?.kind).toBe('instant');
    expect(parsed?.at.toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(parseFieldDateTime('2026-07-01T15:00:00.000Z')?.at.toISOString()).toBe(
      '2026-07-01T15:00:00.000Z',
    );
  });

  it('returns null for any other shape', () => {
    for (const raw of ['', 'not a date', '2026-07-01', 'July 1 2026 3:00 PM', '2026-13-45T99:99']) {
      expect(parseFieldDateTime(raw)).toBeNull();
    }
  });
});

describe('parseExpiryInstant', () => {
  it('pins a DATE value to midnight UTC of that calendar day', () => {
    expect(parseExpiryInstant('2026-07-01')?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
  });

  it('reads a zone-less DATETIME value as UTC', () => {
    expect(parseExpiryInstant('2026-07-01T15:00')?.toISOString()).toBe('2026-07-01T15:00:00.000Z');
  });

  it('keeps the instant of a zoned DATETIME value', () => {
    expect(parseExpiryInstant('2026-07-01T15:00-07:00')?.toISOString()).toBe(
      '2026-07-01T22:00:00.000Z',
    );
  });

  it('returns null for an unparseable value', () => {
    for (const raw of ['', 'not a date', 'July 1 2026', '2026-13-45', '2026-07-01 15:00']) {
      expect(parseExpiryInstant(raw)).toBeNull();
    }
  });

  // Server-zone independence is proven with real zone switches in
  // apps/api/src/expirations/expiry-instant.spec.ts. Assigning
  // `process.env.TZ` in a spec here would not switch it: Jest gives each
  // spec a copy of `process.env`.
});
