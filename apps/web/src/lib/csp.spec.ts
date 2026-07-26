import { buildCsp, isMobileAppPath } from './csp';

/**
 * The CSP is the kind of header that regresses silently: nothing fails,
 * nothing logs, a page just stops executing its own scripts. Before this
 * spec existed, `CHANGELOG-SECURITY.md` recorded that no test asserted
 * the policy string at all.
 *
 * Two properties matter most here, and each has a distinct failure mode:
 *
 *  - The `/m` branch must NOT carry `'strict-dynamic'`, or the static
 *    Vite bundle's nonce-less `<script>` is blocked and `/m` renders
 *    blank.
 *  - Every other path MUST keep it, or Next's nonce plumbing degrades to
 *    "any same-origin script runs" across the whole desktop app.
 */

const NONCE = 'test-nonce-value';

function policy(pathname: string, opts?: { isDev?: boolean; isHttps?: boolean }) {
  return buildCsp({
    pathname,
    nonce: NONCE,
    isDev: opts?.isDev ?? false,
    isHttps: opts?.isHttps ?? false,
  });
}

/** Pull a single directive out of a policy string. */
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe('isMobileAppPath', () => {
  it.each(['/m', '/m/', '/m/app', '/m/login', '/m/passwords/abc'])(
    'matches %s',
    (p) => expect(isMobileAppPath(p)).toBe(true),
  );

  // The reason the predicate is `=== '/m' || startsWith('/m/')` rather
  // than `startsWith('/m')`. Every path here is a real route in this app,
  // and each would have been served the nonce-less policy by the naive
  // version.
  it.each([
    '/me',
    '/me/sessions',
    '/mfa/challenge',
    '/mfa/setup',
    '/manifest.webmanifest',
    '/',
    '/login',
    '/admin',
    '/media',
  ])('does not match %s', (p) => expect(isMobileAppPath(p)).toBe(false));
});

describe('buildCsp — /m (static PWA bundle)', () => {
  const paths = ['/m', '/m/app', '/m/login', '/m/passwords/abc'];

  it.each(paths)('%s has no strict-dynamic', (p) => {
    expect(policy(p)).not.toContain("'strict-dynamic'");
  });

  it.each(paths)('%s allows no inline script', (p) => {
    expect(directive(policy(p), 'script-src')).toBe("script-src 'self'");
  });

  it.each(paths)('%s states worker-src for the Phase 3 service worker', (p) => {
    expect(directive(policy(p), 'worker-src')).toBe("worker-src 'self'");
  });

  it.each(paths)('%s states manifest-src so the PWA installs', (p) => {
    expect(directive(policy(p), 'manifest-src')).toBe("manifest-src 'self'");
  });

  // Phase 0 has no image consumer. Camera previews and the MFA QR both
  // arrive in Phase 2 and must widen this deliberately, with a changelog
  // entry — not inherit a scheme granted early "just in case".
  it.each(paths)('%s grants img-src exactly self — no blob:, no data:', (p) => {
    expect(directive(policy(p), 'img-src')).toBe("img-src 'self'");
  });

  it('never permits unsafe-eval, even in dev', () => {
    expect(policy('/m/app', { isDev: true })).not.toContain("'unsafe-eval'");
  });

  it('adds upgrade-insecure-requests only over HTTPS', () => {
    expect(policy('/m/app', { isHttps: true })).toContain(
      'upgrade-insecure-requests',
    );
    expect(policy('/m/app', { isHttps: false })).not.toContain(
      'upgrade-insecure-requests',
    );
  });
});

describe('buildCsp — desktop app', () => {
  const paths = ['/', '/me', '/mfa/challenge', '/manifest.webmanifest', '/admin'];

  it.each(paths)('%s keeps the nonce and strict-dynamic', (p) => {
    const csp = policy(p);
    expect(csp).toContain(`'nonce-${NONCE}'`);
    expect(csp).toContain("'strict-dynamic'");
  });

  it.each(paths)('%s keeps img-src free of blob: and data:', (p) => {
    expect(directive(policy(p), 'img-src')).toBe("img-src 'self'");
  });

  it('permits unsafe-eval in dev only (webpack HMR needs it)', () => {
    expect(policy('/', { isDev: true })).toContain("'unsafe-eval'");
    expect(policy('/', { isDev: false })).not.toContain("'unsafe-eval'");
  });

  it('permits websockets in dev only (HMR)', () => {
    expect(directive(policy('/', { isDev: true }), 'connect-src')).toBe(
      "connect-src 'self' ws: wss:",
    );
    expect(directive(policy('/', { isDev: false }), 'connect-src')).toBe(
      "connect-src 'self'",
    );
  });
});

describe('buildCsp — invariants across both branches', () => {
  const everywhere = ['/', '/m/app', '/me', '/m'];

  it.each(everywhere)('%s locks down object/frame/base/form', (p) => {
    const csp = policy(p);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it.each(everywhere)('%s defaults to same-origin', (p) => {
    expect(directive(policy(p), 'default-src')).toBe("default-src 'self'");
  });
});
