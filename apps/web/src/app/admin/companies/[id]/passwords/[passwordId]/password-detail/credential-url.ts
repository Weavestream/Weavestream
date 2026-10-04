/**
 * Display form of a credential URL: host plus a shortened path, with
 * opaque ids (UUIDs, long hex, ULIDs, cuids) dropped and long segments
 * elided. The raw value stays on the link's `title` and in the copy
 * action; this only shapes what fits on one line.
 */
export function formatCredentialUrl(value: string | null): string {
  if (!value) return '';
  const parse = (candidate: string) => {
    try {
      return new URL(candidate);
    } catch {
      return null;
    }
  };

  const parsed = parse(value) ?? parse(`https://${value}`);
  if (!parsed) return shortenPath(value.split(/[?#]/)[0] ?? value);

  const path = shortenPath(parsed.pathname);
  return `${parsed.hostname}${path === '/' ? '' : path}`;
}

export function shortenPath(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? path;
  const segments = clean
    .split('/')
    .filter(Boolean)
    .filter((segment) => !isOpaqueUrlSegment(segment))
    .map((segment) => shortenUrlSegment(segment));

  const collapsed = segments.filter((segment, index) => segment !== segments[index - 1]);
  return collapsed.length > 0 ? `/${collapsed.join('/')}` : '/';
}

function isOpaqueUrlSegment(segment: string): boolean {
  const decoded = decodeURIComponentSafe(segment);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)) {
    return true;
  }
  if (/^[0-9a-f]{24,}$/i.test(decoded)) return true;
  if (/^[0-9a-f-]{24,}$/i.test(decoded) && /[0-9a-f]/i.test(decoded)) {
    return true;
  }
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(decoded)) return true;
  if (/^c[a-z0-9]{20,}$/i.test(decoded)) return true;
  return false;
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function shortenUrlSegment(segment: string): string {
  if (segment.length <= 32) return segment;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) {
    return `${segment.slice(0, 8)}...`;
  }
  if (/^[0-9a-f-]{24,}$/i.test(segment)) return `${segment.slice(0, 8)}...`;
  return `${segment.slice(0, 24)}...${segment.slice(-8)}`;
}
