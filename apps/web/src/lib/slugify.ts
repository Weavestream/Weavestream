/**
 * Slug generators for the layout builder.
 *
 * Both lowercase the input, strip everything except `[a-z0-9]`, whitespace and
 * underscores, trim, then collapse whitespace runs to `_`. They differ ONLY in
 * the length cap — layout slugs at 48 characters, field slugs at 60 — which is
 * exactly why they are two named exports over one shared transform rather than
 * one function with a magic number at each call site. Two same-named `slugify`
 * helpers with different caps used to sit two directories apart, which is the
 * mistake this module exists to prevent.
 *
 * The company slug (`company-format.ts`, `-` separator, 40 chars) and the NFKD
 * heading-anchor slug (`article-toc.tsx`, 80 chars) use different character
 * sets and caps, as do the API-side slugifiers in `folders.service.ts` and
 * `articles.service.ts`. None of them belong here.
 */
function baseSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

/** Layout slug — 48-character cap. */
export function slugifyLayoutSlug(s: string): string {
  return baseSlug(s).slice(0, 48);
}

/** Field slug — 60-character cap. Also used for a dropdown choice's slug. */
export function slugifyFieldSlug(s: string): string {
  return baseSlug(s).slice(0, 60);
}
