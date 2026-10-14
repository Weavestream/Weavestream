/**
 * Fixed policy for the remote MCP authorization server. Code constants, not
 * settings: changing any of them changes who can obtain a token.
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
 * Every redirect URI in an accepted document must be https on one of these.
 * `claude.com` is listed only so a Claude document that names it still
 * works. Loopback redirects are refused, so Claude Code stays on stdio.
 */
export const REDIRECT_HOSTS: ReadonlySet<string> = new Set(['claude.ai', 'claude.com', 'chatgpt.com']);

/** Hosts the authorization server may fetch from (documents and their JWKS). */
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

/** Accept a client_id only from the allowlist, before any fetch. */
export function isAllowedClientId(clientId: string): boolean {
  if (clientId === CHATGPT_CLIENT_ID) return true;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname === CLAUDE_CLIENT_HOST && !url.port;
}

/** Every redirect URI must be https on an allowed host, with no custom port. */
export function areAllowedRedirects(redirectUris: readonly string[]): boolean {
  return (
    redirectUris.length > 0 &&
    redirectUris.every((uri) => {
      try {
        const url = new URL(uri);
        return url.protocol === 'https:' && !url.port && REDIRECT_HOSTS.has(url.hostname);
      } catch {
        return false;
      }
    })
  );
}

export function mcpResourceUrl(appOrigin: string): string {
  return `${appOrigin}/mcp`;
}
