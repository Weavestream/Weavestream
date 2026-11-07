/**
 * Early warning (integration robustness, rule 5): the source version saved
 * on each sync run. Shared by the drivers that read a version and by the
 * service that saves it, so the stored label has one definition.
 */

/** Longest label stored (`integration_sync_runs.source_*_version`). */
export const SOURCE_VERSION_MAX_LENGTH = 64;

// A plain version label: `0.126.0`, `v1.2.3-rc.1`, `1.0.0+build.7`, `1`.
const SOURCE_VERSION_LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u;

/**
 * The version as a short label safe to show and store, or null when the
 * source sent none or something that is not a plain version string. The
 * value is never truncated: a label that does not fit is not a version.
 */
export function sourceVersionLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > SOURCE_VERSION_MAX_LENGTH) return null;
  return SOURCE_VERSION_LABEL.test(value) ? value : null;
}
