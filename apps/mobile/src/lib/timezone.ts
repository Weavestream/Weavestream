import { normalizeTimeZone } from '@weavestream/shared';

/**
 * The timezone every date on this app formats in.
 *
 * The shared date formatters require an explicit zone (the eslint warn
 * on `toLocale*` exists to funnel formatting through them), and mobile
 * has no server-side preference to defer to — `/auth/me` carries no
 * `timezone` field. The device zone is also simply *correct* here: a
 * technician reading "expires Mar 14" is standing in that timezone.
 */
export function deviceTimeZone(): string {
  return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}
