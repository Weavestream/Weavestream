import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NextRequest } from 'next/server';
import {
  DEFAULT_UI_ACCENT,
  UI_COOKIE_NAME,
  parseUiCookie,
  uiAccentValues,
  type UiAccent,
} from '@weavestream/shared';
import { looksLikeStaticAsset } from '../../../lib/mobile-shell-paths';

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
 */
const isProd = process.env.NODE_ENV === 'production';
const cache = new Map<UiAccent, string>();

async function loadShell(accent: UiAccent): Promise<string | null> {
  if (isProd) {
    const hit = cache.get(accent);
    if (hit) return hit;
  }
  try {
    const html = await readFile(join(SHELL_DIR, `${accent}.html`), 'utf8');
    if (isProd) cache.set(accent, html);
    return html;
  } catch {
    return null;
  }
}

function isAccent(value: string): value is UiAccent {
  return (uiAccentValues as readonly string[]).includes(value);
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
  if (pathname === '/m') {
    return Response.redirect(new URL('/m/app', req.nextUrl), 308);
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

  // Pick the accent-specific shell variant. The variants are generated
  // at build time, one per member of `uiAccentValues`; selecting one is
  // a lookup keyed by a closed set, NOT string substitution of
  // request-derived data into HTML (CLAUDE.md §3).
  //
  // `req.cookies` is already percent-decoded by Next.
  const raw = req.cookies.get(UI_COOKIE_NAME)?.value;
  const preferred = parseUiCookie(raw).uiAccent;
  const accent = isAccent(preferred) ? preferred : DEFAULT_UI_ACCENT;

  const html = (await loadShell(accent)) ?? (await loadShell(DEFAULT_UI_ACCENT));

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
