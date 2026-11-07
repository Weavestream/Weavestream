import type { DriverObservedField } from './drivers/integration-driver.js';

/**
 * Sync holds: Weavestream stops writing or archiving when the source changes
 * in a way that could lose synced data, and waits for an operator.
 *
 * - Field hold: a field that was present on every object of the last clean
 *   traversal is absent from every object on a page. The page writes
 *   nothing, because a missing key would otherwise read as an empty value.
 * - Removal hold: a full traversal would archive too many records at once
 *   (see `IntegrationProvenanceService.staleUnseen`).
 * - Version hold: the source reported a schema version the driver does not
 *   know (`DriverSourceVersionHoldError`). The resource reads, writes, and
 *   archives nothing until the version is known or an operator accepts it.
 *
 * The presence baseline and both holds live on the sync checkpoint. They are
 * key paths and counts only, never source values.
 */

/** A baseline is built only from a traversal with at least this many records. */
export const PRESENCE_BASELINE_MIN_RECORDS = 5;
/** A path is watched only when it was present on at least this many objects (all of them). */
export const PRESENCE_WATCH_MIN_OBJECTS = 5;
/** Most observed paths a page may report, and a baseline may keep. */
export const PRESENCE_MAX_PATHS = 1_024;
/** Most paths named in one field hold. */
const FIELD_HOLD_MAX_PATHS = 20;

const PATH_PATTERN = /^[A-Za-z0-9_$.[\]-]{1,256}$/u;
const VARIANT_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export interface PresenceCount {
  path: string;
  variant?: string;
  present: number;
  objects: number;
}

export interface FieldPresenceBaseline {
  v: 1;
  updatedAt: string;
  records: number;
  paths: Record<string, PresenceCount>;
}

export interface FieldHold {
  since: string;
  paths: string[];
}

export interface RemovalHold {
  since: string;
  count: number;
  total: number;
}

/** Stable key of a path within its record variant. */
export function presenceKey(field: { path: string; variant?: string }): string {
  return field.variant ? `${field.variant}:${field.path}` : field.path;
}

/** Operator text for a path: `addresses[].assignment` (device records). */
export function presenceLabel(field: { path: string; variant?: string }): string {
  return field.variant ? `\`${field.path}\` (${field.variant} records)` : `\`${field.path}\``;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPresenceCount(value: unknown): value is PresenceCount {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' && PATH_PATTERN.test(v.path) &&
    (v.variant === undefined || (typeof v.variant === 'string' && VARIANT_PATTERN.test(v.variant))) &&
    isCount(v.present) && isCount(v.objects) && v.present <= v.objects
  );
}

/**
 * A driver's page report, or null when it sent none or sent one that is not
 * well formed. The report is advisory: a bad one disables the check for the
 * traversal instead of failing the page.
 */
export function validateObservedFields(raw: unknown): DriverObservedField[] | null {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > PRESENCE_MAX_PATHS) return null;
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isPresenceCount(entry)) return null;
    const key = presenceKey(entry);
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return (raw as PresenceCount[]).map((entry) => ({
    path: entry.path,
    ...(entry.variant ? { variant: entry.variant } : {}),
    present: entry.present,
    objects: entry.objects,
  }));
}

export function parseFieldPresence(raw: unknown): FieldPresenceBaseline | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (v.v !== 1 || typeof v.updatedAt !== 'string' || !isCount(v.records)) return null;
  if (!v.paths || typeof v.paths !== 'object') return null;
  const paths: Record<string, PresenceCount> = {};
  for (const [key, count] of Object.entries(v.paths as Record<string, unknown>)) {
    if (isPresenceCount(count) && presenceKey(count) === key) paths[key] = count;
  }
  return { v: 1, updatedAt: v.updatedAt, records: v.records, paths };
}

/** Paths present on every object of the baseline, over enough objects to trust. */
export function watchedPaths(baseline: FieldPresenceBaseline | null): PresenceCount[] {
  if (!baseline) return [];
  return Object.values(baseline.paths).filter(
    (count) => count.objects >= PRESENCE_WATCH_MIN_OBJECTS && count.present === count.objects,
  );
}

/**
 * Watched paths that this page has objects for, and no object carried.
 * A path whose location has no objects on this page says nothing either way.
 */
export function findFieldDrift(
  watched: readonly PresenceCount[],
  observed: readonly DriverObservedField[] | null,
): PresenceCount[] {
  if (!observed || watched.length === 0) return [];
  const byKey = new Map(observed.map((field) => [presenceKey(field), field]));
  return watched.filter((path) => {
    const page = byKey.get(presenceKey(path));
    return page !== undefined && page.objects >= 1 && page.present === 0;
  });
}

/** Add a page's report to the traversal totals. False when the bound is hit. */
export function accumulatePresence(
  totals: Map<string, PresenceCount>,
  observed: readonly DriverObservedField[],
): boolean {
  for (const field of observed) {
    const key = presenceKey(field);
    const current = totals.get(key);
    if (current) {
      current.present += field.present;
      current.objects += field.objects;
    } else {
      if (totals.size >= PRESENCE_MAX_PATHS) return false;
      totals.set(key, { ...field });
    }
  }
  return true;
}

export function buildFieldPresence(
  totals: ReadonlyMap<string, PresenceCount>,
  records: number,
  at: Date,
): FieldPresenceBaseline {
  const paths: Record<string, PresenceCount> = {};
  for (const [key, count] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    paths[key] = { ...count };
  }
  return { v: 1, updatedAt: at.toISOString(), records, paths };
}

export function parseFieldHold(raw: unknown): FieldHold | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.since !== 'string' || !Array.isArray(v.paths)) return null;
  const paths = v.paths.filter((path): path is string => typeof path === 'string').slice(0, FIELD_HOLD_MAX_PATHS);
  return { since: v.since, paths };
}

/** Add drifted paths to a hold, keeping the first `since`. */
export function mergeFieldHold(
  current: FieldHold | null,
  drift: readonly PresenceCount[],
  at: Date,
): FieldHold {
  const paths = new Set(current?.paths ?? []);
  for (const path of drift) paths.add(presenceKey(path));
  return {
    since: current?.since ?? at.toISOString(),
    paths: [...paths].sort().slice(0, FIELD_HOLD_MAX_PATHS),
  };
}

export function parseRemovalHold(raw: unknown): RemovalHold | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.since !== 'string' || !isCount(v.count) || !isCount(v.total)) return null;
  return { since: v.since, count: v.count, total: v.total };
}

export interface VersionHold {
  since: string;
  /** Sanitized version label from the driver (or `unrecognized`). */
  version: string;
}

/** `{ since, version }` from the checkpoint, or null when absent or malformed. */
export function parseVersionHold(raw: unknown): VersionHold | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.since !== 'string' || typeof v.version !== 'string') return null;
  return { since: v.since, version: v.version.slice(0, 32) };
}

export function fieldDriftMessage(
  sourceLabel: string,
  resourceLabel: string,
  drift: readonly PresenceCount[],
): string {
  const named = drift.slice(0, 5).map(presenceLabel).join(', ');
  const more = drift.length > 5 ? ` and ${drift.length - 5} more` : '';
  return `${sourceLabel} stopped sending ${named}${more} for ${resourceLabel}. Nothing was changed. Review the change, then run a sync with "Accept changes from ${sourceLabel}" to continue.`
    .slice(0, 500);
}

export function removalHoldMessage(
  sourceLabel: string,
  resourceLabel: string,
  hold: { count: number; total: number },
): string {
  return `${sourceLabel} returned far fewer ${resourceLabel} records than before (${hold.count} of ${hold.total} missing from two full syncs). Nothing was archived. Review the change, then run a sync with "Accept changes from ${sourceLabel}" to archive them.`
    .slice(0, 500);
}
