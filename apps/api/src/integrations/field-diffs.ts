import type { IntegrationFieldDiff } from '../assets/assets.service.js';

/**
 * Differences between a standard field a person changed and the source
 * value, stored per binding on `IntegrationSyncRecord.fieldDiffs`, plus the
 * "Keep ours" choices in `fieldResolutions` (both keyed by AssetField.id).
 * The columns are rewritten together on every sync of a resource that
 * declares `standardFields`; this module holds the pure merge rules.
 */

export interface StoredFieldDiff extends IntegrationFieldDiff {
  detectedAt: string;
}

export interface StoredFieldResolution {
  choice: 'local';
  sourceFingerprint: string;
}

type Obj = Record<string, unknown>;

const isObj = (value: unknown): value is Obj =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Defensive read of `fieldDiffs`: malformed entries are dropped. */
export function parseFieldDiffs(value: unknown): Record<string, StoredFieldDiff> {
  const out: Record<string, StoredFieldDiff> = {};
  if (!isObj(value)) return out;
  for (const [fieldId, entry] of Object.entries(value)) {
    if (
      isObj(entry) &&
      typeof entry['sourceFingerprint'] === 'string' &&
      typeof entry['localFingerprint'] === 'string' &&
      typeof entry['detectedAt'] === 'string'
    ) {
      out[fieldId] = {
        sourceValue: entry['sourceValue'] ?? null,
        sourceFingerprint: entry['sourceFingerprint'],
        localFingerprint: entry['localFingerprint'],
        detectedAt: entry['detectedAt'],
      };
    }
  }
  return out;
}

/** Defensive read of `fieldResolutions`. */
export function parseFieldResolutions(value: unknown): Record<string, StoredFieldResolution> {
  const out: Record<string, StoredFieldResolution> = {};
  if (!isObj(value)) return out;
  for (const [fieldId, entry] of Object.entries(value)) {
    if (isObj(entry) && entry['choice'] === 'local' && typeof entry['sourceFingerprint'] === 'string') {
      out[fieldId] = { choice: 'local', sourceFingerprint: entry['sourceFingerprint'] };
    }
  }
  return out;
}

/**
 * The binding's next diffs and resolutions from this sync's fresh diffs.
 * A "Keep ours" choice hides its field while the source value is the one
 * it was made against; once the source changes (or nothing differs any
 * more) the choice is dropped. A diff keeps its first `detectedAt` while
 * both values stay the same.
 */
export function mergeFieldDiffs(
  fresh: Readonly<Record<string, IntegrationFieldDiff>>,
  previousDiffs: unknown,
  previousResolutions: unknown,
  now: Date,
): { fieldDiffs: Record<string, StoredFieldDiff>; fieldResolutions: Record<string, StoredFieldResolution> } {
  const before = parseFieldDiffs(previousDiffs);
  const resolutions = parseFieldResolutions(previousResolutions);
  const fieldDiffs: Record<string, StoredFieldDiff> = {};
  const fieldResolutions: Record<string, StoredFieldResolution> = {};
  for (const [fieldId, diff] of Object.entries(fresh)) {
    const kept = resolutions[fieldId];
    if (kept && kept.sourceFingerprint === diff.sourceFingerprint) {
      fieldResolutions[fieldId] = kept;
      continue;
    }
    const prior = before[fieldId];
    const same =
      prior &&
      prior.sourceFingerprint === diff.sourceFingerprint &&
      prior.localFingerprint === diff.localFingerprint;
    fieldDiffs[fieldId] = { ...diff, detectedAt: same ? prior.detectedAt : now.toISOString() };
  }
  return { fieldDiffs, fieldResolutions };
}

/** Display text for a standard field value (they are never files or references). */
export function differenceDisplayValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => differenceDisplayValue(item) ?? '').filter(Boolean).join(', ') || null;
  return JSON.stringify(value).slice(0, 1_000);
}
