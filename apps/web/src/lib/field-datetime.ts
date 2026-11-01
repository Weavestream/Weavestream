import { formatDateTime } from '@weavestream/shared';

/**
 * DATETIME asset field values come in 2 shapes, and they mean different things:
 *
 *   - Zone-less (`2026-07-01T15:00`): what both asset forms save from a
 *     `datetime-local` input. It is the wall-clock time the user typed, with
 *     no zone, so it shows exactly as entered for every viewer.
 *   - Zoned (`…Z` or `…+02:00`): an instant (API `Date` input, imports). It
 *     shows in the viewer's zone, like every other timestamp.
 *
 * Never hand a zone-less value to `new Date()` / `Date.parse()` and render the
 * result: each runtime reads it in its OWN zone, so the SSR render (UTC in the
 * container) and the browser render disagree — a hydration mismatch and a
 * shifted time. Everything here is runtime-zone-independent.
 *
 * Both patterns mirror the API's `ISO_DATETIME` gate in
 * `apps/api/src/field-types/strategies/date.strategy.ts`. Anything else is
 * not resolvable deterministically, so callers show the raw string.
 */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

export type FieldDateTime =
  /** `at` holds the typed wall-clock fields read as UTC. */
  | { kind: 'wall-clock'; at: Date }
  | { kind: 'instant'; at: Date };

/** Resolve a stored DATETIME value, or null when it is not one of the 2 shapes. */
export function parseFieldDateTime(raw: string): FieldDateTime | null {
  const kind = WALL_CLOCK.test(raw)
    ? 'wall-clock'
    : ZONED.test(raw)
      ? 'instant'
      : null;
  if (!kind) return null;
  const at = new Date(kind === 'wall-clock' ? `${raw}Z` : raw);
  return Number.isNaN(at.getTime()) ? null : { kind, at };
}

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
