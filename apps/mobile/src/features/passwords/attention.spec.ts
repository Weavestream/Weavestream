import { attentionTier, needsAttention } from './attention';
import { makePasswordSummary } from './test-fixtures';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('needsAttention (mirror of the desktop nav-badge predicate)', () => {
  it('counts an already-expired credential, boundary inclusive', () => {
    expect(needsAttention(makePasswordSummary({ expiresAt: iso(NOW - 1) }), NOW)).toBe(true);
    expect(needsAttention(makePasswordSummary({ expiresAt: iso(NOW) }), NOW)).toBe(true);
    // Expiring *soon* is NOT attention — matches desktop.
    expect(needsAttention(makePasswordSummary({ expiresAt: iso(NOW + 1) }), NOW)).toBe(false);
  });

  it('counts an overdue rotation, from lastRotatedAt + reminder days', () => {
    const overdue = makePasswordSummary({
      lastRotatedAt: iso(NOW - 31 * DAY),
      rotationReminderDays: 30,
    });
    const dueToday = makePasswordSummary({
      lastRotatedAt: iso(NOW - 30 * DAY),
      rotationReminderDays: 30,
    });
    const fresh = makePasswordSummary({
      lastRotatedAt: iso(NOW - 5 * DAY),
      rotationReminderDays: 30,
    });
    expect(needsAttention(overdue, NOW)).toBe(true);
    expect(needsAttention(dueToday, NOW)).toBe(true);
    expect(needsAttention(fresh, NOW)).toBe(false);
  });

  it('needs BOTH rotation fields — a reminder without a rotation date is silent', () => {
    expect(
      needsAttention(
        makePasswordSummary({ rotationReminderDays: 30, lastRotatedAt: null }),
        NOW,
      ),
    ).toBe(false);
  });

  it('counts pwned>0; null means "not checked yet", never attention', () => {
    expect(needsAttention(makePasswordSummary({ pwnedCount: 287 }), NOW)).toBe(true);
    expect(needsAttention(makePasswordSummary({ pwnedCount: 0 }), NOW)).toBe(false);
    expect(needsAttention(makePasswordSummary({ pwnedCount: null }), NOW)).toBe(false);
  });

  it('never counts archived rows, whatever else is wrong with them', () => {
    const archived = makePasswordSummary({
      archivedAt: iso(NOW - DAY),
      expiresAt: iso(NOW - DAY),
      pwnedCount: 99,
    });
    expect(needsAttention(archived, NOW)).toBe(false);
  });
});

describe('attentionTier (show-more disclosure dot)', () => {
  it('danger when expired or rotation overdue', () => {
    expect(attentionTier(makePasswordSummary({ expiresAt: iso(NOW - 1) }), NOW)).toBe('danger');
    expect(
      attentionTier(
        makePasswordSummary({ lastRotatedAt: iso(NOW - 40 * DAY), rotationReminderDays: 30 }),
        NOW,
      ),
    ).toBe('danger');
  });

  it('warn inside the 30-day window, boundary inclusive', () => {
    expect(attentionTier(makePasswordSummary({ expiresAt: iso(NOW + 29 * DAY) }), NOW)).toBe('warn');
    expect(attentionTier(makePasswordSummary({ expiresAt: iso(NOW + 30 * DAY) }), NOW)).toBe('warn');
    expect(attentionTier(makePasswordSummary({ expiresAt: iso(NOW + 31 * DAY) }), NOW)).toBeNull();
  });

  it('excludes pwned — the strength row already shows it, the dot flags only hidden facts', () => {
    expect(attentionTier(makePasswordSummary({ pwnedCount: 287 }), NOW)).toBeNull();
  });

  it('null for archived rows and for records with no expiry pressure', () => {
    expect(attentionTier(makePasswordSummary(), NOW)).toBeNull();
    expect(
      attentionTier(
        makePasswordSummary({ archivedAt: iso(NOW), expiresAt: iso(NOW - DAY) }),
        NOW,
      ),
    ).toBeNull();
  });
});
