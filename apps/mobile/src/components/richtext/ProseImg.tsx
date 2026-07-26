import { safeProseHref } from '@weavestream/shared';
import { parseCssWidth, str } from './attr';

/**
 * The ONE image policy for user-stored prose, used by both render paths
 * (the Tiptap walker and react-markdown's `img` override).
 *
 * `src` goes through `safeProseHref`, exactly like anchors: article
 * bodies store same-origin `/api/v1/companies/…/uploads/…/image` paths
 * (streamed by the API, covered by `/m`'s `img-src 'self'`, cookies
 * ride along same-origin), which pass verbatim. An external https URL
 * renders honestly — CSP blocks the fetch in production, dev shows it.
 * Anything rejected (`javascript:`, `mailto:`, control chars) renders
 * the alt text instead of an element.
 *
 * `width` handles the desktop editor's persisted `"320px"` strings;
 * the `.m-prose img` CSS `max-width: 100%` clamps whatever survives to
 * the 390pt column.
 */
export function ProseImg({
  src,
  alt,
  title,
  width,
}: {
  src: unknown;
  alt?: unknown;
  title?: unknown;
  width?: unknown;
}) {
  const raw = str(src);
  const safe = raw === null ? null : safeProseHref(raw);
  const altText = str(alt) ?? '';
  if (safe === null) {
    return altText ? <span className="text-meta text-muted">{altText}</span> : null;
  }
  const w = parseCssWidth(width);
  return (
    <img
      src={safe}
      alt={altText}
      title={str(title) ?? undefined}
      loading="lazy"
      style={w !== null ? { width: `${w}px` } : undefined}
    />
  );
}
