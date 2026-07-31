import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import { UI_COOKIE_NAME, parseUiCookie } from '@weavestream/shared';
import { looksLikeStaticAsset } from '../../../lib/mobile-shell-paths';
import {
  FALLBACK_SHELL_KEY,
  shellKeyFor,
} from '../../../lib/mobile-shell-key';

/**
 * Serves the mobile PWA's HTML shell for every `/m` route.
 *
 * **Why a route handler and not the public folder.** Next resolves
 * `public/` files by exact set membership, so a `public/m/index.html`
 * would answer `/m/index.html` and nothing else — not `/m`, and not a
 * deep link like `/m/passwords/abc`. A client-routed SPA needs every
 * unmatched path under its prefix to return the same shell.
 *
 * **Why not a rewrite in next.config.js.** `headers()` matches the
 * *incoming* path, so a single `/m/:path*` rule would put `no-store` on
 * the hashed assets too, and there is no clean way to express
 * "everything under /m except /m/assets" without a negative lookahead.
 * A handler gives the shell an unambiguous `no-store` and leaves assets
 * to the public folder plus one header rule.
 *
 * Real files under `public/m/assets/*` never reach this code: Next's
 * filesystem check runs before dynamic routes, so only pathless URLs
 * fall through. (And the dev-mode public/page collision error checks
 * exact membership in the app-route set, which a catch-all is not part
 * of, so it cannot fire here.)
 *
 * **This route is deliberately unauthenticated.** The shell contains no
 * data. Every `/api/v1/*` call the SPA makes is authorized server-side
 * against the session exactly as the desktop app's are — that is the
 * whole reason the PWA ships same-origin. Do not add a session gate
 * here; the SPA discovers its own auth state from its first `/auth/me`.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SHELL_DIR = join(process.cwd(), 'mobile-shell');

/**
 * Cache variants in production; re-read every request in dev so a
 * rebuild is picked up without restarting the Next server.
 *
 * Keyed by shell key (`{accent}-{themePref}`) — `shellKeyFor` only ever
 * produces members of the enum cross-product, so the cache is bounded.
 */
const isProd = process.env.NODE_ENV === 'production';
const cache = new Map<string, string>();

async function loadShell(key: string): Promise<string | null> {
  if (isProd) {
    const hit = cache.get(key);
    if (hit) return hit;
  }
  try {
    const html = await readFile(join(SHELL_DIR, `${key}.html`), 'utf8');
    if (isProd) cache.set(key, html);
    return html;
  } catch {
    return null;
  }
}


async function handler(req: NextRequest): Promise<Response> {
  const { pathname } = req.nextUrl;

  // `/m` is the short, linkable entry point; `/m/app` is the canonical
  // start_url, chosen so the manifest can scope to `/m/` without the
  // prefix bleeding into `/me` and `/mfa/*`. See
  // apps/mobile/MANIFEST-NOTES.md — this redirect and that scope are one
  // decision, and "simplifying" either half reintroduces a bug.
  //
  // No loop: Next's own trailing-slash normalization turns `/m/` into
  // `/m`, and `/m/app` needs no normalization, so the chain terminates.
  //
  // The `Location` is deliberately RELATIVE, not built from
  // `req.nextUrl`. `nextUrl`'s origin is whatever host the container was
  // reached on — behind a reverse proxy that is the *internal* address,
  // and when the edge sends no usable `Host` at all Next falls back to
  // its own listen origin (`http://localhost:3000`). Either way an
  // absolute redirect sends the browser to an address that only resolves
  // inside the host, and `/m` is unreachable from every other device. It
  // is also a host-header open redirect wherever the edge forwards a
  // client-supplied `Host` verbatim. A relative reference is resolved by
  // the browser against the address bar, so it is correct on every
  // topology without the app trusting a forwarded header at all
  // (RFC 7231 §7.1.2 permits it, and `Response.redirect` does not — hence
  // the hand-built response).
  //
  // `no-store` because a 308 is otherwise cached indefinitely: a client
  // that saw one bad hop would keep following it out of its own cache
  // long after the server stopped sending it.
  if (pathname === '/m') {
    return new Response(null, {
      status: 308,
      headers: { location: '/m/app', 'cache-control': 'no-store' },
    });
  }

  // A missing static file must 404, not fall back to the shell — see
  // `looksLikeStaticAsset`. `no-store` is set explicitly so that even if
  // a header rule matches this path by pattern, nothing durable is
  // cached against a URL whose content does not exist.
  if (looksLikeStaticAsset(pathname)) {
    return new Response(req.method === 'HEAD' ? null : 'Not found', {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  // Pick the shell variant for this user's accent + theme preference.
  // The variants are generated at build time, one per member of
  // `uiAccentValues` × `uiThemeValues`; selecting one is a lookup keyed
  // by a closed set, NOT string substitution of request-derived data
  // into HTML (CLAUDE.md §3).
  //
  // `req.cookies` is already percent-decoded by Next.
  const raw = req.cookies.get(UI_COOKIE_NAME)?.value;
  const key = shellKeyFor(parseUiCookie(raw));

  const html = (await loadShell(key)) ?? (await loadShell(FALLBACK_SHELL_KEY));

  if (!html) {
    // The bundle has not been published into this container. Log the
    // detail; tell the client nothing about paths or build commands
    // (CLAUDE.md §6). In a real deployment the prebuild guard makes this
    // unreachable — it is here for local dev before a first build.
    console.error(
      `[mobile] no shell variants found in ${SHELL_DIR}. ` +
        'Run `pnpm --filter @weavestream/mobile build`.',
    );
    return new Response('Mobile app is unavailable.', {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  }

  return new Response(req.method === 'HEAD' ? null : html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cache the shell. A stale shell pointing at asset hashes
      // that no longer exist is the classic PWA white screen, and this
      // is the one file that decides which hashes the browser asks for.
      // (Assets themselves are `max-age=0` + ETag, not `immutable` —
      // see next.config.js. The publisher additionally keeps one
      // previous asset generation alive, so a reader who loaded this
      // shell just before a deploy is not stranded either.)
      'cache-control': 'no-store',
    },
  });
}

export const GET = handler;
export const HEAD = handler;
