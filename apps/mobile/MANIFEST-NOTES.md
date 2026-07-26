# Why `scope: "/m/"` but `start_url: "/m/app"`

This exact combination is load-bearing. Both of the obvious
simplifications are broken, and each fails in a way that is easy to miss:

**`scope: "/m"`** — manifest scope matching is a *string prefix on the
path*, so `/m` also covers `/me`, `/me/sessions`, `/mfa/challenge`, and
`/manifest.webmanifest`. Those are real desktop routes in this app, and
they would be treated as inside the installed PWA.

**`scope: "/m/"` with `start_url: "/m/"`** — deadlocks. Next's default
`trailingSlash: false` redirects `/m/` → `/m`, and `/m` is *outside* a
`/m/` scope, so the installed app navigates out of scope on every launch.
Making the route handler redirect `/m` → `/m/` instead produces an
infinite loop against Next's own normalization.

A child start URL escapes both: `/m/app` is inside `/m/` scope, and it
carries no trailing slash, so Next's normalization never fires on it.
Bare `/m` is handled by a 308 to `/m/app`, which terminates.

The alternative — setting `skipTrailingSlashRedirect: true` — was
rejected: it is a global routing-semantics change to serve one subtree,
and it degrades `shouldPreflightAuth`'s exact-equality check on
`/access-pending` in `apps/web/src/proxy.ts`.

## The two literal hexes

`theme_color` and `background_color` cannot reference CSS custom
properties, so `#fafaf9` is hardcoded. It is the light `--bg` from
`packages/shared/styles/color-tokens.css`. Everything else in the mobile
app consumes the shared vars; these two are the unavoidable exception,
and they need updating by hand if the light background ever changes.
