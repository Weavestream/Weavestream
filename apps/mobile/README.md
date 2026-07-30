# Weavestream Mobile (`apps/mobile`)

The dedicated field-technician PWA, served same-origin at `/m` by the
Next.js container. Vite + React 19 + TanStack Router/Query, static
bundle by construction (a future Capacitor build is a packaging step,
not a port). Product rules live in the repo-root `CLAUDE.md`; the build
history in `Build_Plan/Mobile/mobile-pwa-build-plan.md`.

## Persistence doctrine (read this before caching anything)

**Nothing this app fetches is persisted to disk. This is a decision,
not an omission** (confirmed with the Phase 3 offline decision,
2026-07-27).

- **Never persist a revealed secret.** Reveal responses and password
  *detail* responses (which carry decrypted `notes`) live in memory and
  clear on blur/background. The Ask anything transcript is memory-only
  too — it can quote sensitive documentation — and resets on org
  switch.
- **No TanStack Query persister — global or otherwise.** The persister
  plugin cannot distinguish a list query from a reveal query, so a
  "quick win" global persister would write credentials to disk. If list
  *metadata* caching is ever revisited, it needs a threat model, a
  per-query **opt-in** with reveal/detail queries structurally
  excluded, and probably a customer-facing setting — never a default.
- Offline therefore shows the honest "no connection" states
  (`components/states.tsx`), not stale data.
- The service worker caches **code, never data** — see below.

## Service worker (`src/sw.ts` → `/m/sw.js`)

Compiled by `vite-plugin-pwa` (`injectManifest`); registered from
`main.tsx` as a bundled module (`injectRegister: null` — the `/m` CSP
is `script-src 'self'`, no inline scripts, see
`apps/web/src/lib/csp.ts`). Prod-only; the Vite dev server never
registers one.

What it caches:

| Cache | Contents | Strategy |
|---|---|---|
| precache | content-hashed js/css/woff2 | install-time, cleaned up by Workbox |
| `ws-m-shell-<ver>` | `/m` navigation responses (the accent-substituted shell) | NetworkFirst — online always gets the fresh `no-store` shell |
| `ws-m-canonical-<ver>` | ONE pinned copy of `/m/app` | warmed at install (install-blocking), refreshed by every successful HTML navigation, served by the catch handler so any deep link boots offline |

**The invariant that matters: `/api/*` has NO route.** A request
matching no route and no precache entry is never intercepted by
Workbox, so the worker structurally cannot cache, buffer, or delay
credential-bearing traffic or the Ask anything SSE stream. Do not add
an `/api` route — not even `NetworkOnly`.

Never precache HTML: `dist/index.html` carries the `__WS_ACCENT__`
placeholder (the real shell is accent-substituted per request by the
`/m` route handler). `emit-to-web.mjs` hard-fails the publish if an
`.html` entry sneaks into the injected manifest.

Cache names embed a fingerprint of the precache manifest, so an
installing worker never touches the active worker's caches; a failed
canonical warm **rejects install** (the old worker stays fully in
service) and activation deletes prior versions.

**Rollback:** publish one build with `selfDestroying: true` in the
VitePWA config to unregister the worker fleet-wide, then remove the
flag once clients have picked it up.

## Publish pipeline

`pnpm --filter @weavestream/mobile build` = `vite build` +
`scripts/emit-to-web.mjs`, which publishes:

- `apps/web/public/m/` — hashed assets, `manifest.webmanifest`,
  `sw.js` (served by Next's public folder at `max-age=0` + ETag —
  correct for SW update checks; deliberately never `immutable`).
- `apps/web/mobile-shell/` — one HTML shell **per accent × theme-pref**
  pair, named `{accent}-{pref}.html` (5 accents × `dark`/`light`/`system`
  = 15 variants), outside `public/` so the `no-store` route handler is
  the only way to reach it. Each is stamped with the accent, the raw
  preference, and the *resolved* theme, so first paint is correct in
  pure CSS with no inline script (§3 + the `/m` CSP). Plus the
  `mobile-build.json` marker (**schema 3**: asset list, `accents`,
  `themePrefs`, per-variant shell hashes keyed `{accent}-{pref}`,
  `serviceWorker` + its sha256, and the `/m/...` URLs the shell links).

Publication merges assets additively, swaps shells atomically, and
keeps one previous generation so a reader mid-load across a deploy
cannot 404. `apps/web`'s prebuild (`scripts/check-mobile-bundle.mjs`)
refuses to build against a missing, stale, or half-copied bundle —
including a missing or hash-mismatched `sw.js`, a marker schema that
isn't 3, or a `themePrefs` set that doesn't match the shared enum.

## Development notes

- `pnpm dev` serves on :5173 and proxies `/api` to Next on :3000 so
  cookie auth, CSRF, and the XFF-sanitizing proxy stay in the dev path.
  No service worker in dev.
- Dedicated docs: `MANIFEST-NOTES.md` (why `scope: "/m/"` +
  `start_url: "/m/app"` are one decision with the bare-`/m` 308).
- Icons are generated path data (`scripts/gen-icons.mjs`), never a
  webfont; add glyph names there and rerun `pnpm gen:icons` — never
  hand-edit `icon-paths.ts`.
- `randomClientId()` from `@weavestream/shared/browser`, never
  `crypto.randomUUID()` — the app is routinely served over plain HTTP
  to LAN devices in dev, where secure-context crypto is undefined.
- No client-side token refresh: `AuthGuard.silentRefresh` rotates the
  session server-side; a 401 means the session is genuinely gone —
  route to login, never retry.
