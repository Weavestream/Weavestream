import { formatDateTime, parseFieldDateTime } from '@weavestream/shared';

/**
 * Display helpers for DATETIME asset field values. The parser and the 2-shape
 * rule live in `@weavestream/shared` (`parseFieldDateTime`), shared with the
 * API expiry code:
 *
 *   - A zone-less value (`2026-07-01T15:00`) is the wall-clock time the user
 *     typed, so it shows exactly as entered for every viewer.
 *   - A zoned value (`…Z` or `…+02:00`) is an instant, so it shows in the
 *     viewer's zone, like every other timestamp.
 *
 * Everything here is runtime-zone-independent, so the SSR render (UTC in the
 * container) and the browser render agree.
 */

/**
 * `"Jul 1, 2026, 03:00 PM"`: a wall-clock value as entered, an instant in
 * `timeZone`. Null when the value is not resolvable.
 */
export function formatFieldDateTime(raw: string, timeZone: string): string | null {
  const parsed = parseFieldDateTime(raw);
  if (!parsed) return null;
  return formatDateTime(parsed.at, parsed.kind === 'wall-clock' ? 'UTC' : timeZone);
}

/**
 * Sort key that orders values the way they DISPLAY: the wall-clock time the
 * viewer sees, as milliseconds with those fields read as UTC. A wall-clock
 * value keys on its own fields; an instant keys on its fields in `timeZone`.
 * So a zone-less `15:00` sorts after an instant that shows as `1:00 PM`, even
 * when that instant is later in absolute time. Null when unresolvable.
 */
export function fieldDateTimeSortKey(raw: string, timeZone: string): number | null {
  const parsed = parseFieldDateTime(raw);
  if (!parsed) return null;
  return parsed.kind === 'wall-clock'
    ? parsed.at.getTime()
    : wallClockMs(parsed.at, timeZone);
}

/** One formatter per zone: a sort calls this once per row. */
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

/** `at`'s wall-clock fields in `timeZone`, read back as a UTC timestamp. */
function wallClockMs(at: Date, timeZone: string): number {
  let dtf = wallClockFormatters.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallClockFormatters.set(timeZone, dtf);
  }
  const v: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const part of dtf.formatToParts(at)) v[part.type] = Number(part.value);
  return Date.UTC(
    v.year ?? 0,
    (v.month ?? 1) - 1,
    v.day ?? 1,
    v.hour ?? 0,
    v.minute ?? 0,
    v.second ?? 0,
    at.getUTCMilliseconds(),
  );
}
