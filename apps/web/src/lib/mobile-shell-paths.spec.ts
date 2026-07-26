import { looksLikeStaticAsset } from './mobile-shell-paths';

/**
 * Regression guard for the worst bug found in Phase 0 review.
 *
 * The `/m` catch-all originally returned the SPA shell for *any*
 * unmatched path, including `/m/assets/<hash>.js`. Because
 * `next.config.js` matched `/m/assets/:path*` by pathname and applied an
 * `immutable, max-age=31536000` header regardless of the response, a
 * request for a deleted asset produced `200 text/html` cached for a year
 * under a JavaScript URL. Every later load then parsed HTML as a script.
 * Permanent for that browser, and unfixable by redeploying.
 */
describe('looksLikeStaticAsset', () => {
  it.each([
    '/m/assets/index-CWUyyzp4.js',
    '/m/assets/index-CKuhVR94.css',
    '/m/assets/geist-sans-latin-400-normal-gapTbOY8.woff2',
    '/m/assets/does-not-exist.js',
    '/m/manifest.webmanifest',
    '/m/index.html',
    '/m/shell.html',
    '/m/sw.js',
  ])('treats %s as a static resource (404, never the shell)', (p) => {
    expect(looksLikeStaticAsset(p)).toBe(true);
  });

  it.each([
    '/m/app',
    '/m/login',
    '/m/mfa/challenge',
    '/m/passwords/abc',
    '/m/assets',
    '/m/companies/acme-inc/passwords',
  ])('treats %s as a client route (serve the shell)', (p) => {
    expect(looksLikeStaticAsset(p)).toBe(false);
  });

  it('does not misread a dot in an earlier segment as an extension', () => {
    // Only the final segment decides; a dotted directory or slug must
    // still reach the SPA router.
    expect(looksLikeStaticAsset('/m/v1.2/app')).toBe(false);
  });
});
