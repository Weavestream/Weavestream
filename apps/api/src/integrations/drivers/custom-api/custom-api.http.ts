import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import {
  CUSTOM_API_LIMITS,
  customApiHeaderSecretKey,
  isReservedHeaderName,
  placeholdersIn,
  type CustomApiDefinition,
  type CustomApiPlaceholder,
  type CustomApiRequest,
} from '@weavestream/shared';
import { DriverAuthError, DriverRateLimitError, type IntegrationContext } from '../integration-driver.js';
import { fetchWithRetry } from '../driver-utils.js';

/**
 * Requests of the Custom API driver: URL building, headers,
 * authentication, the OAuth token cache and response handling.
 *
 * Every request goes through `fetchWithRetry` (and so `safeFetch`, the
 * egress guard) with `timeoutCoversBody`, never follows a redirect, and
 * may only go to the Base URL origin under its path prefix (the token
 * URL is the one exception and is a separate HTTPS URL in the
 * definition). Errors carry fixed text and the HTTP status; upstream
 * bodies are never put into an error, a log line or a response.
 */

const logger = new Logger('CustomApiDriver');

/** One request's inputs. `tokenCache: 'none'` keeps OAuth tokens to this call (Test). */
export interface CustomApiCall {
  readonly definition: CustomApiDefinition;
  readonly secret: Record<string, unknown>;
  readonly http: IntegrationContext['http'];
  readonly correlationId: string;
  readonly integrationId?: string;
  readonly credentialVersion?: string;
  /**
   * `shared`: the process-wide token cache keyed by integration (syncs).
   * `none`: the token lives in `local` only and the shared cache is never
   * read or written (Test requests, so a draft never gets a production
   * token and never leaves one behind).
   */
  readonly tokenCache: 'shared' | 'none';
  readonly local: { token?: CachedToken };
}

export function customApiCall(
  ctx: IntegrationContext,
  definition: CustomApiDefinition,
  tokenCache: 'shared' | 'none',
): CustomApiCall {
  return {
    definition,
    secret: ctx.secret ?? {},
    http: ctx.http,
    correlationId: ctx.correlationId,
    integrationId: ctx.integrationId,
    credentialVersion: ctx.credentialVersion,
    tokenCache,
    local: {},
  };
}

/** A non-OK answer or an unusable response; fixed text and the status only. */
export class CustomApiRequestError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'CustomApiRequestError';
  }
}

/** The API or the token endpoint refused the credentials, or none are saved. */
export class CustomApiAuthError extends DriverAuthError {
  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'CustomApiAuthError';
  }
}

export type PlaceholderValues = Partial<Record<CustomApiPlaceholder, string>>;

export interface RequestTarget {
  url: string;
  method: 'GET' | 'POST';
  body?: string;
}

function baseOf(baseUrl: string): { origin: string; prefix: string } {
  const base = new URL(baseUrl);
  return { origin: base.origin, prefix: base.pathname.replace(/\/+$/, '') };
}

/** True when `url` has the Base URL origin and stays under its path prefix. */
export function isWithinBase(baseUrl: string, url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    // Not a URL at all.
    return false;
  }
  const { origin, prefix } = baseOf(baseUrl);
  if (target.origin !== origin || target.username || target.password) return false;
  return prefix === '' || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}

/** A placeholder value that would act as a dot segment in a path. */
function isDotSegment(value: string): boolean {
  return value === '.' || value === '..';
}

/** `{name}` → value; `encode` URL-encodes each value once. Undefined when a placeholder has no value. */
function fill(template: string, vars: PlaceholderValues, encode: boolean): string | undefined {
  let missing = false;
  const out = template.replace(/\{([^{}]*)\}/g, (_match, name: string) => {
    const value = vars[name as CustomApiPlaceholder];
    if (value === undefined) {
      missing = true;
      return '';
    }
    return encode ? encodeURIComponent(value) : value;
  });
  return missing ? undefined : out;
}

/** The POST body with placeholders filled; a value that is only an unset placeholder is left out. */
function fillBody(value: unknown, vars: PlaceholderValues): unknown {
  if (typeof value === 'string') {
    if (placeholdersIn(value).length === 0) return value;
    const filled = fill(value, vars, false);
    return filled;
  }
  if (Array.isArray(value)) return value.map((item) => fillBody(item, vars)).filter((item) => item !== undefined);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const filled = fillBody(item, vars);
      if (filled !== undefined) out[key] = filled;
    }
    return out;
  }
  return value;
}

/**
 * The URL, method and body for one request. Placeholder values are
 * URL-encoded once; a query parameter whose placeholder has no value
 * (`{cursor}` on the first page) is left out. The finished URL must
 * have the Base URL origin and path prefix.
 */
export function buildRequestTarget(baseUrl: string, request: CustomApiRequest, vars: PlaceholderValues): RequestTarget {
  for (const name of placeholdersIn(request.path)) {
    const value = vars[name as CustomApiPlaceholder];
    if (value !== undefined && isDotSegment(value)) {
      throw new CustomApiRequestError('A value for the request path is not allowed.', null);
    }
  }
  const path = fill(request.path, vars, true);
  if (path === undefined) throw new CustomApiRequestError('The request path needs a value that is not set.', null);
  const { origin, prefix } = baseOf(baseUrl);
  const url = new URL(`${origin}${prefix}${path}`);
  for (const [key, template] of Object.entries(request.query)) {
    const value = fill(template, vars, false);
    if (value !== undefined) url.searchParams.append(key, value);
  }
  const href = url.toString();
  if (!isWithinBase(baseUrl, href)) {
    throw new CustomApiRequestError('The request URL leaves the Base URL. Check the request path.', null);
  }
  const target: RequestTarget = { url: href, method: request.method };
  if (request.method === 'POST' && request.body !== undefined) {
    target.body = JSON.stringify(fillBody(request.body, vars));
  }
  return target;
}

function secretString(secret: Record<string, unknown>, key: string): string {
  const value = secret[key];
  if (typeof value !== 'string' || value === '') {
    throw new CustomApiAuthError('The credentials for this API are not saved. Enter them on the Credentials & schedule tab.', null);
  }
  return value;
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Definition headers, then the auth header. Reserved names are refused again here, at send time. */
async function requestHeaders(call: CustomApiCall, forceNewToken: boolean): Promise<Record<string, string>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const set = (name: string, value: string) => {
    if (isReservedHeaderName(name) && name.toLowerCase() !== 'authorization') {
      throw new CustomApiRequestError('A header in the definition is not allowed.', null);
    }
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
    headers[name] = value;
  };
  for (const header of call.definition.headers) {
    if (isReservedHeaderName(header.name)) throw new CustomApiRequestError('A header in the definition is not allowed.', null);
    set(header.name, 'secret' in header ? secretString(call.secret, customApiHeaderSecretKey(header.name)) : header.value);
  }
  const auth = call.definition.auth;
  switch (auth.method) {
    case 'none':
      break;
    case 'bearer':
      set('Authorization', `Bearer ${secretString(call.secret, 'token')}`);
      break;
    case 'header':
      if (isReservedHeaderName(auth.headerName)) throw new CustomApiRequestError('A header in the definition is not allowed.', null);
      set(auth.headerName, secretString(call.secret, 'value'));
      break;
    case 'basic':
      set('Authorization', `Basic ${base64(`${auth.username}:${secretString(call.secret, 'password')}`)}`);
      break;
    case 'oauth_client_credentials':
      set('Authorization', `Bearer ${await accessToken(call, forceNewToken)}`);
      break;
  }
  return headers;
}

// ---------------------------------------------------------------------
// OAuth client credentials
// ---------------------------------------------------------------------

export interface CachedToken {
  token: string;
  expiresAt: number;
  /** Hash of everything that produced the token; a mismatch means "get a new one". */
  fingerprint: string;
}

/** Used until this long before `expires_in`. */
const TOKEN_EARLY_EXPIRY_MS = 60_000;
/** Lifetime assumed when the token endpoint gives no `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_S = 3_600;

/**
 * Process-wide access tokens of syncs, keyed `id:<integrationId>`.
 * ponytail: single process; another worker gets its own token.
 */
const tokenCache = new Map<string, CachedToken>();

/** @internal only `*.spec.ts` should call this. */
export function __resetCustomApiTokenCacheForTests(): void {
  tokenCache.clear();
}

/** @internal only `*.spec.ts` should call this. */
export function __customApiTokenCacheForTests(): ReadonlyMap<string, CachedToken> {
  return tokenCache;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Everything a cached token depends on: the saved credential row, the
 * hosts, the token request settings, the client id and a hash of the
 * client secret. Never a raw secret.
 */
function tokenFingerprint(call: CustomApiCall): string {
  const auth = call.definition.auth;
  if (auth.method !== 'oauth_client_credentials') return '';
  return sha256(JSON.stringify([
    call.credentialVersion ?? '',
    new URL(call.definition.baseUrl).origin,
    auth.tokenUrl,
    auth.scope ?? '',
    auth.clientAuth,
    secretString(call.secret, 'clientId'),
    sha256(secretString(call.secret, 'clientSecret')),
  ]));
}

function sharedKey(call: CustomApiCall): string | null {
  return call.tokenCache === 'shared' && call.integrationId ? `id:${call.integrationId}` : null;
}

function dropToken(call: CustomApiCall): void {
  delete call.local.token;
  const key = sharedKey(call);
  if (key) tokenCache.delete(key);
}

async function accessToken(call: CustomApiCall, forceNew: boolean): Promise<string> {
  const fingerprint = tokenFingerprint(call);
  const key = sharedKey(call);
  const now = Date.now();
  if (!forceNew) {
    const cached = key ? tokenCache.get(key) : call.local.token;
    if (cached && cached.fingerprint === fingerprint && cached.expiresAt > now) return cached.token;
    if (key && cached) tokenCache.delete(key);
  }
  const { token, expiresInS } = await exchangeToken(call);
  const entry: CachedToken = {
    token,
    expiresAt: now + Math.max(0, expiresInS * 1_000 - TOKEN_EARLY_EXPIRY_MS),
    fingerprint,
  };
  if (key) tokenCache.set(key, entry);
  else call.local.token = entry;
  return token;
}

async function exchangeToken(call: CustomApiCall): Promise<{ token: string; expiresInS: number }> {
  const auth = call.definition.auth;
  if (auth.method !== 'oauth_client_credentials') throw new Error('not an OAuth definition');
  const clientId = secretString(call.secret, 'clientId');
  const clientSecret = secretString(call.secret, 'clientSecret');
  const form = new URLSearchParams({ grant_type: 'client_credentials' });
  if (auth.scope) form.set('scope', auth.scope);
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (auth.clientAuth === 'basic') {
    // RFC 6749 §2.3.1: form-encode each part before joining.
    headers.Authorization = `Basic ${base64(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`)}`;
  } else {
    form.set('client_id', clientId);
    form.set('client_secret', clientSecret);
  }
  const res = await send(call, auth.tokenUrl, { method: 'POST', headers, body: form.toString() }, CUSTOM_API_LIMITS.tokenResponseBytes);
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    await discard(res);
    throw new CustomApiAuthError(`The token endpoint refused the client credentials (${res.status}).`, res.status);
  }
  if (!res.ok) {
    await discard(res);
    throw new CustomApiRequestError(`The token endpoint returned an error (${res.status}).`, res.status);
  }
  const json = await readJson(res, 'The token endpoint did not return JSON.');
  const body = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const token = body.access_token;
  if (typeof token !== 'string' || token === '' || token.length > 8_192 || /[\r\n]/.test(token)) {
    throw new CustomApiAuthError('The token endpoint did not return an access token.', res.status);
  }
  const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0
    ? body.expires_in
    : DEFAULT_TOKEN_LIFETIME_S;
  return { token, expiresInS: expiresIn };
}

// ---------------------------------------------------------------------
// Sending and reading
// ---------------------------------------------------------------------

async function send(
  call: CustomApiCall,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  maxResponseBytes?: number,
): Promise<Response> {
  try {
    return await fetchWithRetry(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: 'error',
      timeoutMs: call.http.timeoutMs,
      maxRetries: call.http.maxRetries,
      backoffMs: call.http.backoffMs,
      correlationId: call.correlationId,
      serviceName: 'Custom API',
      timeoutCoversBody: true,
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    });
  } catch (e) {
    throw transportError(e, call);
  }
}

/** Maps a transport failure to fixed text; the raw reason goes to the DEBUG log only. */
function transportError(e: unknown, call: CustomApiCall): Error {
  if (e instanceof DriverRateLimitError || e instanceof CustomApiRequestError || e instanceof DriverAuthError) return e;
  logger.debug({ correlationId: call.correlationId, err: e instanceof Error ? e.name : typeof e }, 'custom api request failed');
  if (e instanceof Error && e.name === 'EgressBlockedError') {
    return new CustomApiRequestError(
      'The address is not allowed. To reach a private network, an administrator adds its range to EGRESS_ALLOWED_PRIVATE_CIDRS.',
      null,
    );
  }
  if (e instanceof Error && /^safeFetch response exceeded/.test(e.message)) {
    return new CustomApiRequestError('The response is too large.', null);
  }
  if (e instanceof Error && /deadline|timeout|aborted/i.test(`${e.name} ${e.message}`)) {
    return new CustomApiRequestError('The API did not answer in time.', null);
  }
  return new CustomApiRequestError('The API could not be reached.', null);
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // The body is not needed; a failed cancel only leaves it to be collected.
  }
}

async function readJson(res: Response, notJson: string): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw transportErrorForBody(e);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CustomApiRequestError(notJson, res.status);
  }
}

function transportErrorForBody(e: unknown): Error {
  if (e instanceof Error && /exceeded/.test(e.message) && /bytes/.test(e.message)) {
    return new CustomApiRequestError('The response is too large.', null);
  }
  return new CustomApiRequestError('The API did not send the whole response in time.', null);
}

export interface CustomApiResponse {
  json: unknown;
  /** The `Link` header, for link_header pagination. */
  link: string | null;
  url: string;
}

/**
 * Sends one data request. With OAuth, a 401 drops the token and the
 * request is sent once more with a new one; a second 401 is a
 * DriverAuthError.
 */
export async function customApiRequest(call: CustomApiCall, target: RequestTarget): Promise<CustomApiResponse> {
  if (!isWithinBase(call.definition.baseUrl, target.url)) {
    throw new CustomApiRequestError('The request URL leaves the Base URL.', null);
  }
  const oauth = call.definition.auth.method === 'oauth_client_credentials';
  const attempt = async (forceNewToken: boolean) => {
    const headers = await requestHeaders(call, forceNewToken);
    if (target.body !== undefined) headers['Content-Type'] = 'application/json';
    return send(call, target.url, { method: target.method, headers, body: target.body });
  };
  let res = await attempt(false);
  if (res.status === 401 && oauth) {
    await discard(res);
    dropToken(call);
    res = await attempt(true);
  }
  if (res.status === 401 || res.status === 403) {
    await discard(res);
    if (oauth && res.status === 401) dropToken(call);
    throw new CustomApiAuthError(`The API refused the credentials (${res.status}).`, res.status);
  }
  if (res.status >= 300 && res.status < 400) {
    await discard(res);
    throw new CustomApiRequestError(`The API answered with a redirect (${res.status}). Use the final address in the Base URL or the request path.`, res.status);
  }
  if (res.status === 404) {
    await discard(res);
    throw new CustomApiRequestError('The API did not find this path (404). Check the request path.', 404);
  }
  if (!res.ok) {
    await discard(res);
    throw new CustomApiRequestError(`The API returned an error (${res.status}).`, res.status);
  }
  const json = await readJson(res, 'The API did not return JSON.');
  return { json, link: res.headers.get('link'), url: target.url };
}
