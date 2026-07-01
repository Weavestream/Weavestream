/**
 * SSR-safe date/time formatting.
 *
 * A React Client Component renders on BOTH the SSR server (Node ICU, system
 * timezone) and the browser (browser ICU, the visitor's timezone). Any
 * `toLocaleString` / `Intl` call that lets either the timezone OR the ICU
 * date/time connector float produces different text on the two renders, and
 * React throws away the subtree with a hydration mismatch. These helpers make
 * the output deterministic:
 *
 *   - the locale is pinned to `en-US`, so month / AM-PM strings never follow
 *     each runtime's default;
 *   - the string is assembled from `formatToParts` with our OWN separators, so
 *     the ICU connector (older ", " vs newer " at ", and the regular- vs
 *     narrow-space before AM/PM) can't leak in — the part *values* agree
 *     across ICU versions;
 *   - the `timeZone` is always explicit, so server and client agree on the
 *     wall-clock value.
 *
 * Pure `Intl` — no DOM, no Node APIs — so this module is safe to import from
 * both server and client components (it lives in the client-safe
 * `@weavestream/shared` barrel).
 */

export type DateInput = string | Date | null | undefined;

/** Rendered for nullish / unparseable inputs. */
const PLACEHOLDER = '—';

/** Coerce to a valid `Date`, or `null` for nullish / unparseable input. */
function toDate(value: DateInput): Date | null {
  if (value == null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Return a usable IANA time-zone id, falling back to `'UTC'`.
 *
 * `User.timezone` is only validated as `z.string().max(64)` on write, so a
 * stale or malformed value can reach us. Constructing an `Intl.DateTimeFormat`
 * with an unknown zone throws a `RangeError` — inside a client component that
 * would crash the render (and hydration). Probing here once turns any bad zone
 * into a deterministic UTC fallback.
 */
export function normalizeTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return 'UTC';
  try {
    // Throws `RangeError` for an unknown zone; cheap to construct.
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

/** Build a part-lookup for `d` in `timeZone` with the given field options. */
function partsOf(
  d: Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): (type: Intl.DateTimeFormatPartTypes) => string {
  const parts = new Intl.DateTimeFormat('en-US', {
    ...options,
    timeZone: normalizeTimeZone(timeZone),
  }).formatToParts(d);
  return (type) => parts.find((p) => p.type === type)?.value ?? '';
}

/** Instant → `"Jul 1, 2026, 08:00 AM"` in the viewer's zone. */
export function formatDateTime(value: DateInput, timeZone: string): string {
  const d = toDate(value);
  if (!d) return PLACEHOLDER;
  const v = partsOf(d, timeZone, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
  return `${v('month')} ${v('day')}, ${v('year')}, ${v('hour')}:${v('minute')} ${v('dayPeriod')}`;
}

/** Instant → `"Jul 1, 08:00 AM"` (no year) in the viewer's zone. */
export function formatShortDateTime(value: DateInput, timeZone: string): string {
  const d = toDate(value);
  if (!d) return PLACEHOLDER;
  const v = partsOf(d, timeZone, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${v('month')} ${v('day')}, ${v('hour')}:${v('minute')} ${v('dayPeriod')}`;
}

/** Instant, date only → `"Jul 1, 2026"` in the viewer's zone. */
export function formatDate(value: DateInput, timeZone: string): string {
  const d = toDate(value);
  if (!d) return PLACEHOLDER;
  const v = partsOf(d, timeZone, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return `${v('month')} ${v('day')}, ${v('year')}`;
}

/**
 * Calendar day → `"Jul 1, 2026"`, formatted in UTC so it never shifts.
 *
 * A calendar date (an asset field of type DATE, an expiry picked from
 * `<input type="date">`) is stored as midnight UTC and represents a *day*, not
 * an instant. Formatting it in a west-of-UTC zone would roll it back to the
 * previous day, so we pin UTC regardless of the viewer's timezone.
 */
export function formatCalendarDate(value: DateInput): string {
  const d = toDate(value);
  if (!d) return PLACEHOLDER;
  const v = partsOf(d, 'UTC', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  return `${v('month')} ${v('day')}, ${v('year')}`;
}

/**
 * Relative age → `"just now"`, `"5m ago"`, `"3h ago"`, `"2d ago"`, falling back
 * to an absolute {@link formatDateTime} for future or >7-day-old instants.
 *
 * `nowMs` is a PARAMETER, never `Date.now()` read internally: a client
 * component evaluates "now" at a different instant on the server render than on
 * hydration, so an internally-read clock reintroduces a hydration mismatch.
 * Callers must supply an SSR-stable `nowMs` (a server-passed timestamp, or a
 * value set in a post-mount effect — see `FormattedRelative`).
 */
export function formatRelative(
  value: DateInput,
  nowMs: number,
  timeZone: string,
): string {
  const d = toDate(value);
  if (!d) return PLACEHOLDER;
  const diff = nowMs - d.getTime();
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  // Future timestamps and anything older than a week read better as an
  // absolute date than as "in -3d" / "412d ago".
  if (diff < 0 || diff >= 7 * DAY) return formatDateTime(value, timeZone);
  if (diff < MIN) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MIN)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}
