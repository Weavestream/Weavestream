import type { McpClientPolicy } from '@weavestream/shared';

/**
 * Fixed policy for the remote MCP authorization server. Code constants, not
 * settings: changing any of them changes who can obtain a token. The admin's
 * client policy (`SystemSetting.mcpClientPolicy`) only chooses which of the
 * two rule sets below applies:
 *  - `claude_chatgpt`: only claude.ai and ChatGPT (the default).
 *  - `any`: any https client metadata document, dynamic registration of
 *    public clients, and loopback redirects for local apps.
 */

/** Where the OAuth endpoints live (`/api/v1/oauth/*`, proxied by web). */
export const OAUTH_MOUNT_PATH = '/api/v1/oauth';

/** The single scope; the read/write grant lives on the connection. */
export const MCP_SCOPE = 'mcp';

/**
 * Client ID Metadata Documents the server will fetch. ChatGPT publishes one
 * stable URL (used when the server returns `iss`, which this one does).
 * Claude does not publish its URL, so any https URL on claude.ai is
 * accepted; the redirect-host rule below closes that gap.
 */
export const CHATGPT_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
export const CLAUDE_CLIENT_HOST = 'claude.ai';

/**
 * In mode `claude_chatgpt`, every redirect URI in an accepted document must be
 * https on one of these. `claude.com` is listed only so a Claude document that
 * names it still works. Loopback redirects are refused in that mode.
 */
export const REDIRECT_HOSTS: ReadonlySet<string> = new Set(['claude.ai', 'claude.com', 'chatgpt.com']);

/** In mode `claude_chatgpt`, the hosts the server may fetch from (documents and their JWKS). */
export const FETCH_HOSTS: ReadonlySet<string> = new Set(['claude.ai', 'chatgpt.com']);

export const TTL = {
  accessToken: 60 * 60,
  authorizationCode: 60,
  /** Idle lifetime: every refresh rotates the token and restarts it. */
  refreshToken: 30 * 24 * 60 * 60,
  /** Absolute lifetime of a connection, the API key default. */
  grant: 365 * 24 * 60 * 60,
  /** The provider's own browser session; never enough to skip consent. */
  session: 10 * 60,
  interaction: 10 * 60,
} as const;

/** Provider cookie names, prefixed so they never collide with ours. */
export const OAUTH_COOKIE_NAMES = {
  session: 'ws_oauth_session',
  interaction: 'ws_oauth_interaction',
  resume: 'ws_oauth_resume',
} as const;

/** Interaction ids are 43-char base64url; anything else is not one. */
export const INTERACTION_UID = /^[A-Za-z0-9_-]{16,64}$/;

/** Hostnames a native app may use for an http redirect (RFC 8252 §7.3). */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Accept a client metadata document URL under the policy, before any fetch.
 *  - `claude_chatgpt`: ChatGPT's one document, or https on claude.ai with no port.
 *  - `any`: https on any host and port, with a path, no credentials and no
 *    fragment.
 */
export function isAllowedClientId(clientId: string, policy: McpClientPolicy = 'claude_chatgpt'): boolean {
  if (policy === 'any') {
    const url = parseUrl(clientId);
    return (
      url !== null &&
      url.protocol === 'https:' &&
      url.pathname !== '/' &&
      !url.username &&
      !url.password &&
      !clientId.includes('#')
    );
  }
  if (clientId === CHATGPT_CLIENT_ID) return true;
  const url = parseUrl(clientId);
  return url !== null && url.protocol === 'https:' && url.hostname === CLAUDE_CLIENT_HOST && !url.port;
}

/**
 * Every redirect URI must pass the policy's rule, and there must be at least one.
 *  - `claude_chatgpt`: https on an allowed host, with no custom port.
 *  - `any`: see {@link isAnyModeRedirect}.
 */
export function areAllowedRedirects(
  redirectUris: readonly string[],
  policy: McpClientPolicy = 'claude_chatgpt',
): boolean {
  return (
    redirectUris.length > 0 &&
    redirectUris.every((uri) => {
      if (policy === 'any') return isAnyModeRedirect(uri);
      const url = parseUrl(uri);
      return url !== null && url.protocol === 'https:' && !url.port && REDIRECT_HOSTS.has(url.hostname);
    })
  );
}

/**
 * A redirect URI allowed in mode `any`: https on any host and port, or http on
 * a loopback address for a native app. Never a fragment, credentials, a custom
 * scheme, or http on any other host.
 */
export function isAnyModeRedirect(uri: string): boolean {
  const url = parseUrl(uri);
  if (!url || uri.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** An http redirect to the user's own computer (a native app's loopback listener). */
export function isLoopbackRedirect(uri: string): boolean {
  const url = parseUrl(uri);
  return url !== null && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * A client is verified when its id is an https URL: its metadata document was
 * fetched from that host. An app that registered itself has an opaque id the
 * server issued, and nothing about it is checked. Never throws.
 */
export function isVerifiedClientId(clientId: string): boolean {
  return parseUrl(clientId)?.protocol === 'https:';
}

/** The verified host of a client, or null for one that registered itself. */
export function clientHostOf(clientId: string): string | null {
  return isVerifiedClientId(clientId) ? new URL(clientId).hostname : null;
}

/**
 * Whether a stored connection would pass the `claude_chatgpt` rules: a
 * Claude or ChatGPT client that returned to one of their hosts.
 */
export function isFirstPartyConnection(row: { clientId: string; redirectHost: string }): boolean {
  return isAllowedClientId(row.clientId, 'claude_chatgpt') && REDIRECT_HOSTS.has(row.redirectHost);
}

/**
 * Whether the policy lets a stored connection work. Narrowing the policy
 * refuses other apps' connections without revoking them, like the on/off
 * switch, so widening it again restores them.
 */
export function connectionAllowed(
  policy: McpClientPolicy,
  row: { clientId: string; redirectHost: string },
): boolean {
  return policy === 'any' || isFirstPartyConnection(row);
}

export function mcpResourceUrl(appOrigin: string): string {
  return `${appOrigin}/mcp`;
}
