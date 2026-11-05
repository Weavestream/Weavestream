import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  CUSTOM_API_LIMITS,
  parsePath,
  readPath,
  resolvePath,
  type CustomApiPagination,
  type CustomApiRequest,
} from '@weavestream/shared';
import {
  CustomApiRequestError,
  buildRequestTarget,
  customApiRequest,
  isWithinBase,
  type CustomApiCall,
  type PlaceholderValues,
  type RequestTarget,
} from './custom-api.http.js';

/**
 * Paging through one list request (organizations or a resource).
 *
 * The driver's own cursor (`DriverFetchPage.cursor`) is opaque JSON with
 * the style and the next value only; nothing is signed into it. Each
 * style has its own end rule. A next-page link to another origin stops
 * the run, and a cursor, URL or page that this walk already used stops
 * it with "The API returned the same page again" (a no-progress check,
 * not a page cap).
 */

/**
 * Where the next page starts. `null` on the first page. `read` (page
 * style only) counts the records of the pages before it, so the walk can
 * compare what it read with the API's total.
 */
export type PageState = { style: CustomApiPagination['style']; next: string | number; read?: number };

/** Longest next-page value (cursor or URL) the walk keeps. */
const MAX_NEXT_LENGTH = 8_192;

const pageStateSchema = z
  .object({
    style: z.enum(['none', 'page', 'offset', 'cursor', 'next_url', 'link_header']),
    next: z.union([z.string().min(1).max(MAX_NEXT_LENGTH), z.number().int().min(0)]),
    read: z.number().int().min(0).optional(),
  })
  .strict();

export function encodePageState(state: PageState | null): string | null {
  return state ? Buffer.from(JSON.stringify(state), 'utf8').toString('base64') : null;
}

export function decodePageState(cursor: string | null, style: CustomApiPagination['style']): PageState | null {
  if (!cursor) return null;
  try {
    const parsed = pageStateSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')));
    // A cursor of another style (the definition changed mid-run) restarts the walk.
    return parsed.success && parsed.data.style === style ? parsed.data : null;
  } catch {
    // A malformed cursor restarts the walk from the first page.
    return null;
  }
}

export interface ListPage {
  /** The raw records of this page. */
  items: unknown[];
  /** The raw response, for the Test key list. */
  json: unknown;
  /** Where the next page starts; null on the last page. */
  next: PageState | null;
}

export interface ListSpec {
  request: CustomApiRequest;
  recordsPath: string;
  pagination: CustomApiPagination;
}

/** The records array at `recordsPath`. The path must find a list. */
export function recordsAt(json: unknown, recordsPath: string): unknown[] {
  const value = resolvePath(json, parsePath(recordsPath));
  if (!Array.isArray(value)) {
    throw new CustomApiRequestError('The records path did not find a list in the response.', null);
  }
  if (value.length > CUSTOM_API_LIMITS.recordsPerPage) {
    throw new CustomApiRequestError(`The API returned more than ${CUSTOM_API_LIMITS.recordsPerPage.toLocaleString('en-US')} records on one page.`, null);
  }
  return value;
}

function totalAt(json: unknown, totalPath: string | undefined): number | null {
  if (!totalPath) return null;
  const read = readPath(json, parsePath(totalPath));
  if (read.kind !== 'value') return null;
  const total = typeof read.value === 'number' ? read.value : Number(read.value);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/** The `rel="next"` URL of a Link header (RFC 8288), or null. */
export function nextFromLinkHeader(header: string | null): string | null {
  if (!header) return null;
  for (const match of header.matchAll(/<([^>]*)>([^,<]*)/g)) {
    const params = match[2] ?? '';
    for (const param of params.split(';')) {
      const [name, rawValue] = param.split('=', 2).map((part) => part?.trim());
      if (name?.toLowerCase() !== 'rel' || !rawValue) continue;
      const rels = rawValue.replace(/^"|"$/g, '').toLowerCase().split(/\s+/);
      if (rels.includes('next')) return match[1] ?? null;
    }
  }
  return null;
}

/**
 * Only a missing, null or empty value ends the walk. Any other value that
 * is not a usable cursor stops the run with an error: reading it as "no
 * more pages" would make a partial read look complete, and a full sync
 * then marks every unseen asset stale.
 */
function cursorValue(json: unknown, cursorPath: string): string | null {
  const read = readPath(json, parsePath(cursorPath));
  // `missing` covers an absent key and null.
  if (read.kind === 'missing') return null;
  if (read.kind === 'not_scalar' || typeof read.value === 'boolean') {
    throw new CustomApiRequestError('The API sent a next-page cursor that is not text or a number. The run stopped.', null);
  }
  const value = String(read.value);
  return value === '' ? null : value;
}

/**
 * A next-page link: relative links resolve against this page; another
 * host is refused. As for cursors, only missing, null or empty ends the walk.
 */
function nextLink(baseUrl: string, currentUrl: string, raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new CustomApiRequestError('The API sent a next-page link that is not text. The run stopped.', null);
  }
  let resolved: string;
  try {
    resolved = new URL(raw, currentUrl).toString();
  } catch {
    throw new CustomApiRequestError('The API sent a next-page link that is not a URL. The run stopped.', null);
  }
  if (!isWithinBase(baseUrl, resolved)) {
    throw new CustomApiRequestError('The API sent a next-page link to a different host or path. The run stopped.', null);
  }
  return resolved;
}

function pageVars(spec: ListSpec, state: PageState | null): PlaceholderValues {
  const p = spec.pagination;
  switch (p.style) {
    case 'page':
      return { page: String(state ? state.next : p.firstPage), limit: String(p.pageSize) };
    case 'offset':
      return { offset: String(state ? state.next : 0), limit: String(p.pageSize) };
    case 'cursor':
      return {
        ...(state ? { cursor: String(state.next) } : {}),
        ...(p.pageSize ? { limit: String(p.pageSize) } : {}),
      };
    default:
      return {};
  }
}

function target(call: CustomApiCall, spec: ListSpec, vars: PlaceholderValues, state: PageState | null): RequestTarget {
  const built = buildRequestTarget(call.definition.baseUrl, spec.request, vars);
  if (state && (state.style === 'next_url' || state.style === 'link_header')) {
    const url = String(state.next);
    if (!isWithinBase(call.definition.baseUrl, url)) {
      throw new CustomApiRequestError('The API sent a next-page link to a different host or path. The run stopped.', null);
    }
    return { ...built, url };
  }
  return built;
}

/**
 * One page of a list. `orgVars` carries `{orgId}` when the request needs
 * it; `state` is null for the first page.
 */
export async function fetchListPage(
  call: CustomApiCall,
  spec: ListSpec,
  orgVars: PlaceholderValues,
  state: PageState | null,
): Promise<ListPage> {
  const res = await customApiRequest(call, target(call, spec, { ...orgVars, ...pageVars(spec, state) }, state));
  const items = recordsAt(res.json, spec.recordsPath);
  const p = spec.pagination;
  let next: PageState | null = null;
  switch (p.style) {
    case 'none':
      break;
    case 'page': {
      const page = state ? Number(state.next) : p.firstPage;
      const total = totalAt(res.json, p.totalPath);
      // Count the records really read: an API can send fewer than pageSize.
      const read = (state?.read ?? 0) + items.length;
      const done = items.length === 0 || (total !== null ? read >= total : items.length < p.pageSize);
      next = done ? null : { style: 'page', next: page + 1, read };
      break;
    }
    case 'offset': {
      const offset = state ? Number(state.next) : 0;
      const total = totalAt(res.json, p.totalPath);
      const reached = offset + items.length;
      const done = items.length === 0 || (total !== null ? reached >= total : items.length < p.pageSize);
      next = done ? null : { style: 'offset', next: reached };
      break;
    }
    case 'cursor': {
      const value = cursorValue(res.json, p.cursorPath);
      next = value === null ? null : { style: 'cursor', next: value };
      break;
    }
    case 'next_url': {
      const url = nextLink(call.definition.baseUrl, res.url, resolvePath(res.json, parsePath(p.nextUrlPath)));
      next = url === null ? null : { style: 'next_url', next: url };
      break;
    }
    case 'link_header': {
      const url = nextLink(call.definition.baseUrl, res.url, nextFromLinkHeader(res.link));
      next = url === null ? null : { style: 'link_header', next: url };
      break;
    }
  }
  // A longer value would not decode on the next page and restart the walk.
  if (next && typeof next.next === 'string' && next.next.length > MAX_NEXT_LENGTH) {
    throw new CustomApiRequestError(
      `The API sent a next-page value longer than ${MAX_NEXT_LENGTH.toLocaleString('en-US')} characters. The run stopped.`,
      null,
    );
  }
  return { items, json: res.json, next };
}

const SAME_PAGE_MESSAGE = 'The API returned the same page again. The run stopped.';

/**
 * What a walk has seen: the next-page values it used and the contents of
 * its pages. A value or a page seen again means the API sent the same page
 * twice; the walk stops instead of looping forever. The content check
 * catches an API that ignores `{page}` or `{offset}`: those values always
 * grow, so only the records show the repeat. Holds hashes, not values.
 */
export class RepeatGuard {
  private readonly seen = new Set<string>();
  private readonly pages = new Set<string>();

  check(state: PageState | null): void {
    if (!state) return;
    const key = createHash('sha256').update(`${state.style}\0${String(state.next)}`, 'utf8').digest('hex');
    if (this.seen.has(key)) throw new CustomApiRequestError(SAME_PAGE_MESSAGE, null);
    this.seen.add(key);
  }

  /** Records of one page. An empty page is not compared: it carries no records to repeat. */
  checkPage(items: readonly unknown[]): void {
    if (items.length === 0) return;
    const key = createHash('sha256').update(JSON.stringify(items), 'utf8').digest('hex');
    if (this.pages.has(key)) throw new CustomApiRequestError(SAME_PAGE_MESSAGE, null);
    this.pages.add(key);
  }
}

/**
 * Most records one in-memory read holds (organizations, or a resource in
 * `field` mode). A memory bound, not a page cap: a streamed resource sync
 * has no such limit.
 */
export const MAX_ITEMS_IN_MEMORY = 200_000;

/** Every record of a list, page by page, with the repeat check. */
export async function fetchAllItems(call: CustomApiCall, spec: ListSpec, orgVars: PlaceholderValues): Promise<unknown[]> {
  const guard = new RepeatGuard();
  const out: unknown[] = [];
  let state: PageState | null = null;
  for (;;) {
    const page = await fetchListPage(call, spec, orgVars, state);
    guard.checkPage(page.items);
    out.push(...page.items);
    if (out.length > MAX_ITEMS_IN_MEMORY) {
      throw new CustomApiRequestError(`The list has more than ${MAX_ITEMS_IN_MEMORY.toLocaleString('en-US')} records, above what one read holds.`, null);
    }
    if (!page.next) return out;
    guard.check(page.next);
    state = page.next;
  }
}
