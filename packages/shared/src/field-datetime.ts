/**
 * Runtime-zone-independent parsing for DATE / DATETIME asset field values.
 *
 * DATETIME values come in 2 shapes, and they mean different things:
 *
 *   - Zone-less (`2026-07-01T15:00`): what both asset forms save from a
 *     `datetime-local` input. It is the wall-clock time the user typed, with
 *     no zone.
 *   - Zoned (`…Z` or `…+02:00`): an instant (API `Date` input, imports).
 *
 * Never hand a zone-less value to `new Date()` / `Date.parse()`: each runtime
 * reads it in its OWN zone, so the web SSR render (UTC in the container), the
 * browser, and an API process on a developer laptop all disagree. Everything
 * here gives the same result on every runtime zone.
 *
 * Both patterns mirror the API's `ISO_DATETIME` gate in
 * `apps/api/src/field-types/strategies/date.strategy.ts`. Anything else is
 * not resolvable deterministically, so callers treat it as unparseable.
 */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const ZONED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;
/** The DATE field shape (`apps/api/src/field-types/strategies/date.strategy.ts`). */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

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
 * The expiry instant of a DATE or DATETIME field value, or null when the
 * value is not one of the accepted shapes.
 *
 *   - DATE (`2026-07-01`): midnight UTC of that calendar day.
 *   - Zone-less DATETIME (`2026-07-01T15:00`): read as UTC. No company or
 *     workspace timezone exists, and the saver's zone is not stored with the
 *     value, so UTC is the only zone every reader agrees on. It is also how
 *     the production containers (no `TZ`, so UTC) already read these values,
 *     so expiry dismissal keys built from `expiresAt` stay stable.
 *   - Zoned DATETIME: the instant it names.
 */
export function parseExpiryInstant(raw: string): Date | null {
  if (CALENDAR_DAY.test(raw)) {
    const at = new Date(`${raw}T00:00:00Z`);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  return parseFieldDateTime(raw)?.at ?? null;
}
