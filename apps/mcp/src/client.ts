import { HttpToolApi } from '@weavestream/shared/mcp-tools';

/**
 * Minimal Weavestream REST client. Every request carries the user's API key,
 * so the server applies exactly the permissions, tenant scope, rate limits and
 * audit it applies to the same call from any other client. This file adds no
 * authority of its own.
 */

export interface ClientConfig {
  /** Origin of the Weavestream instance, e.g. https://weavestream.example.com */
  baseUrl: string;
  /** `ws_<keyId>_<secret>`. Never logged and never included in errors. */
  apiKey: string;
  fetchImpl?: typeof fetch;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate configuration up front. The key is a long-lived bearer credential,
 * so it is only ever sent over HTTPS (plain HTTP is allowed for loopback dev).
 */
export function parseConfig(env: Record<string, string | undefined>): ClientConfig {
  const rawUrl = env.WEAVESTREAM_URL?.trim();
  const apiKey = env.WEAVESTREAM_API_KEY?.trim();
  if (!rawUrl) throw new Error('WEAVESTREAM_URL is required.');
  if (!apiKey) throw new Error('WEAVESTREAM_API_KEY is required.');
  if (!/^ws_[0-9a-f]+_[A-Za-z0-9_-]+$/.test(apiKey)) {
    throw new Error('WEAVESTREAM_API_KEY does not look like a Weavestream key (ws_…).');
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('WEAVESTREAM_URL is not a valid URL.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error('WEAVESTREAM_URL must use https:// (http:// only for localhost).');
  }
  return { baseUrl: url.origin, apiKey };
}

export class WeavestreamClient extends HttpToolApi {
  constructor(config: ClientConfig) {
    super({
      baseUrl: config.baseUrl,
      credential: 'api-key',
      fetchImpl: config.fetchImpl,
      authorize: () => ({ headers: { authorization: `Bearer ${config.apiKey}` } }),
    });
  }
}
