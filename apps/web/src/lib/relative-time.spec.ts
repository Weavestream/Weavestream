import {
  compactRelative,
  recentRelative,
  shortRelative,
  spacedRelativePast,
  weekCappedRelative,
} from './relative-time';

/**
 * Every bucket boundary of every preset, with `nowMs` pinned so the ladders
 * are deterministic. The point of these cases is that the five presets are
 * NOT interchangeable — each block also asserts where its ladder stops, which
 * is the difference that would otherwise be silently lost if a call site were
 * migrated to the wrong one.
 */

const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** An ISO string for a timestamp `ms` before NOW. */
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('compactRelative', () => {
  it('reads "today" for anything inside 24h — no minute or hour bucket', () => {
    expect(compactRelative(ago(0), NOW)).toBe('today');
    expect(compactRelative(ago(5 * MINUTE), NOW)).toBe('today');
    expect(compactRelative(ago(23 * HOUR), NOW)).toBe('today');
    expect(compactRelative(ago(DAY - 1), NOW)).toBe('today');
  });

  it('steps through days, weeks, months and years at the boundaries', () => {
    expect(compactRelative(ago(DAY), NOW)).toBe('1d ago');
    expect(compactRelative(ago(7 * DAY - 1), NOW)).toBe('6d ago');
    expect(compactRelative(ago(7 * DAY), NOW)).toBe('1w ago');
    expect(compactRelative(ago(30 * DAY - 1), NOW)).toBe('4w ago');
    expect(compactRelative(ago(30 * DAY), NOW)).toBe('1mo ago');
    expect(compactRelative(ago(365 * DAY - 1), NOW)).toBe('12mo ago');
    expect(compactRelative(ago(365 * DAY), NOW)).toBe('1y ago');
    expect(compactRelative(ago(1000 * DAY), NOW)).toBe('2y ago');
  });

  it('accepts a Date as well as an ISO string, identically', () => {
    const d = new Date(NOW - 3 * DAY);
    expect(compactRelative(d, NOW)).toBe('3d ago');
    expect(compactRelative(d.toISOString(), NOW)).toBe(compactRelative(d, NOW));
  });
});

describe('recentRelative', () => {
  it('walks just now → minutes → hours → days', () => {
    expect(recentRelative(new Date(NOW), NOW)).toBe('just now');
    expect(recentRelative(new Date(NOW - MINUTE + 1), NOW)).toBe('just now');
    expect(recentRelative(new Date(NOW - MINUTE), NOW)).toBe('1m ago');
    expect(recentRelative(new Date(NOW - HOUR + 1), NOW)).toBe('59m ago');
    expect(recentRelative(new Date(NOW - HOUR), NOW)).toBe('1h ago');
    expect(recentRelative(new Date(NOW - DAY + 1), NOW)).toBe('23h ago');
    expect(recentRelative(new Date(NOW - DAY), NOW)).toBe('1d ago');
    expect(recentRelative(new Date(NOW - (7 * DAY - 1)), NOW)).toBe('6d ago');
  });

  it('gives up on relative past a week and prints the locale date', () => {
    const old = new Date(NOW - 7 * DAY);
    expect(recentRelative(old, NOW)).toBe(old.toLocaleDateString());
  });
});

describe('shortRelative', () => {
  it('walks just now → minutes → hours → days → weeks', () => {
    expect(shortRelative(ago(0), NOW)).toBe('just now');
    expect(shortRelative(ago(MINUTE), NOW)).toBe('1m ago');
    expect(shortRelative(ago(HOUR), NOW)).toBe('1h ago');
    expect(shortRelative(ago(DAY), NOW)).toBe('1d ago');
    expect(shortRelative(ago(7 * DAY), NOW)).toBe('1w ago');
  });

  it('caps at months — a year-old row reads in months, never years', () => {
    expect(shortRelative(ago(30 * DAY), NOW)).toBe('1mo ago');
    expect(shortRelative(ago(365 * DAY), NOW)).toBe('12mo ago');
    expect(shortRelative(ago(1000 * DAY), NOW)).toBe('33mo ago');
  });
});

describe('weekCappedRelative', () => {
  it('matches shortRelative up to the week boundary', () => {
    for (const ms of [0, MINUTE, HOUR, DAY, 6 * DAY]) {
      expect(weekCappedRelative(ago(ms), NOW)).toBe(shortRelative(ago(ms), NOW));
    }
  });

  it('caps at weeks — months never appear', () => {
    expect(weekCappedRelative(ago(7 * DAY), NOW)).toBe('1w ago');
    expect(weekCappedRelative(ago(30 * DAY), NOW)).toBe('4w ago');
    expect(weekCappedRelative(ago(365 * DAY), NOW)).toBe('52w ago');
  });
});

describe('spacedRelativePast', () => {
  it('passes null straight through', () => {
    expect(spacedRelativePast(null, NOW)).toBeNull();
  });

  it('spaces the unit and rounds rather than floors', () => {
    expect(spacedRelativePast(ago(0), NOW)).toBe('just now');
    expect(spacedRelativePast(ago(29_000), NOW)).toBe('just now');
    expect(spacedRelativePast(ago(30_000), NOW)).toBe('1 min ago');
    expect(spacedRelativePast(ago(90_000), NOW)).toBe('2 min ago');
    expect(spacedRelativePast(ago(59 * MINUTE), NOW)).toBe('59 min ago');
    expect(spacedRelativePast(ago(90 * MINUTE), NOW)).toBe('2 h ago');
    expect(spacedRelativePast(ago(23 * HOUR), NOW)).toBe('23 h ago');
    expect(spacedRelativePast(ago(36 * HOUR), NOW)).toBe('2 d ago');
  });
});
