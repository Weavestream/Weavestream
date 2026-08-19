/**
 * Compact past-tense relative labels for admin tables and list rows.
 *
 * Five presets, because five distinct ladders were in use across the app and
 * each one's rendered output is preserved byte-for-byte. They differ in where
 * they start (minutes vs whole days), where they stop (weeks, months, years,
 * or an absolute date), and how they space the unit — so they are NOT
 * interchangeable, and picking the wrong one silently changes what a column
 * reads. The table in each docstring is the whole specification.
 *
 * Not to be confused with `formatRelative` in `@weavestream/shared`, which
 * falls back to an absolute, timezone-aware date past a week and takes a
 * required `nowMs` because it is rendered through `<FormattedRelative>`. These
 * are the plain client-side ladders; `nowMs` is a parameter so specs can pin
 * the buckets, but it defaults to `Date.now()` to keep the call sites reading
 * exactly as the inline copies did (and to keep a bare `Date.now()` out of
 * JSX, where `react-hooks/purity` objects).
 *
 * Deliberately NOT folded in here: the ladders in `tickets-browser.tsx` (adds
 * a negative-diff guard), `admin/(global)/page.tsx`, `search-palette.tsx`,
 * `drift-banner.tsx`, `article-form.tsx` and `domains-browser.tsx`. Each
 * renders differently from all five below.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * `today` · `3d ago` · `2w ago` · `5mo ago` · `1y ago`
 *
 * Whole-day granularity — anything inside 24h reads `today`, with no minute
 * or hour bucket at all. Used by the admin list/table timestamps.
 *
 * Accepts both an ISO string and a `Date` because its call sites pass each.
 * The `instanceof` branch is load-bearing: `new Date(value)` rejects a `Date`
 * argument under TypeScript, whose constructor overload is `string | number`.
 */
export function compactRelative(value: string | Date, nowMs: number = Date.now()): string {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  const diff = nowMs - ms;
  if (diff < DAY) return 'today';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / (7 * DAY))}w ago`;
  if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))}mo ago`;
  return `${Math.floor(diff / (365 * DAY))}y ago`;
}

/**
 * `just now` · `5m ago` · `3h ago` · `4d ago` · then the locale date
 *
 * Stops being relative after a week and prints `toLocaleDateString()`, so it
 * needs a real `Date`. Used on the asset detail pages.
 *
 * That `toLocaleDateString()` trips `no-restricted-syntax` — deliberately left
 * warning rather than suppressed. It is inherited verbatim from the two copies
 * this replaced (the warning moved here, it did not appear), and the rule is
 * right: this ladder is not hydration-safe. Fixing it means routing these
 * surfaces through `<FormattedRelative>`, which changes rendered output and so
 * is not part of this behavior-preserving pass.
 */
export function recentRelative(d: Date, nowMs: number = Date.now()): string {
  const diff = nowMs - d.getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return d.toLocaleDateString();
}

/**
 * `just now` · `5m ago` · `3h ago` · `4d ago` · `2w ago` · `5mo ago`
 *
 * Full ladder capped at months — no year bucket, so an old row reads
 * `18mo ago` rather than `1y ago`. Used by the users and integrations tables.
 */
export function shortRelative(iso: string, nowMs: number = Date.now()): string {
  const diff = nowMs - new Date(iso).getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  if (diff < 30 * DAY) return `${Math.floor(diff / (7 * DAY))}w ago`;
  return `${Math.floor(diff / (30 * DAY))}mo ago`;
}

/**
 * `just now` · `5m ago` · `3h ago` · `4d ago` · `9w ago`
 *
 * As `shortRelative` but capped at weeks — months never appear. Used by the
 * Cloudflare list views.
 */
export function weekCappedRelative(iso: string, nowMs: number = Date.now()): string {
  const diff = nowMs - new Date(iso).getTime();
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return `${Math.floor(diff / (7 * DAY))}w ago`;
}

/**
 * `just now` · `5 min ago` · `3 h ago` · `4 d ago`
 *
 * The spaced-unit variant used by the domain views. Two further differences
 * from the ladders above, both deliberate: it **rounds** rather than floors at
 * every step, and it accepts `null` (returning `null`) so a missing timestamp
 * passes straight through to the caller's placeholder.
 */
export function spacedRelativePast(
  iso: string | null,
  nowMs: number = Date.now(),
): string | null {
  if (!iso) return null;
  const diff = nowMs - new Date(iso).getTime();
  const mins = Math.round(diff / MINUTE);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.round(hrs / 24);
  return `${days} d ago`;
}
