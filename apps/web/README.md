# @weavestream/web

Next.js App Router frontend for Weavestream.

## Replacing the logo

The app reads all branded imagery from static assets under
`apps/web/public/brand/`. To rebrand, drop the following files in place;
no rebuild is required — Next.js serves them statically.

| File | Used by | Notes |
| --- | --- | --- |
| `public/brand/logo-mark.svg` | Sidebar header, `<AppLogo variant="mark">` | Square, ~512×512. The sidebar renders it at 22 px; keep it legible at that size. |
| `public/brand/logo-wordmark.svg` | Auth shell (login/setup), `<AppLogo>` default | Horizontal wordmark. Aspect ratio should stay close to 5:1 to avoid layout shifts — `AppLogo` caps the rendered width at `height * 7`. |
| `public/brand/logo.svg` | Reserved for marketing surfaces (docs, emails). The app itself does not import this file. | Optional. |

Favicons and social previews are generated dynamically by the App Router
from `src/app/icon.tsx`, `src/app/apple-icon.tsx`, and
`src/app/opengraph-image.tsx`. Replacing the brand SVGs above does **not**
rebuild those three — to refresh the tab icon, hard-reload (⌘⇧R) or
change the asset fingerprint. In the current setup, the generated icons
render an inline initial rather than loading the SVG, so partners
swapping `logo-mark.svg` should follow up with an edit to the
`Icon`/`AppleIcon` components if they want the tab favicon to match.

## Theme + accent

Every user has a server-persisted theme (`dark | light | system`) and
accent (`lime | amber | iris | coral | teal`). See the Phase 9b.1 plan
for the full flow; the entry points are:

- `/me` Appearance panel — segmented control + swatch picker with live
  preview.
- Sidebar footer — one-click dark/light flip (authenticated).
- Login/setup shell top-right — same flip for unauthenticated users,
  persisted in the `ws_ui` cookie via `POST /public/ui-prefs`.
