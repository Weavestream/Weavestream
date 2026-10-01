import { ForbiddenException } from '@nestjs/common';
import { ApiKeySurfaceGuard } from './api-key-surface.guard.js';

function ctxFor(
  path: string,
  apiKeyId?: string,
  interactiveOnly = false,
  allowPasswordReveal = false,
) {
  const req = {
    path,
    user: apiKeyId
      ? { id: 'u-1', apiKeyId, apiKeyAllowPasswordReveal: allowPasswordReveal }
      : { id: 'u-1' },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
    __interactiveOnly: interactiveOnly,
  } as never;
}

/** Reflector stub: reports whatever the context was built with. */
function makeGuard() {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) =>
      key === 'vaultReveal' ? currentVaultReveal : currentInteractiveOnly,
    ),
  };
  return new ApiKeySurfaceGuard(reflector as never);
}
let currentInteractiveOnly = false;
let currentVaultReveal = false;

describe('ApiKeySurfaceGuard', () => {
  const guard = makeGuard();
  beforeEach(() => {
    currentInteractiveOnly = false;
    currentVaultReveal = false;
  });

  describe('cookie sessions', () => {
    it('never interferes with an interactive principal', () => {
      for (const p of [
        '/api/v1/me/api-keys',
        '/api/v1/auth/logout',
        '/api/v1/me/change-password',
        '/api/v1/me/mfa/backup-codes/regenerate',
      ]) {
        expect(guard.canActivate(ctxFor(p))).toBe(true);
      }
    });
  });

  describe('API-key principals', () => {
    /**
     * Routes are mounted under `setGlobalPrefix('api')` with URI versioning, so
     * the guard sees `/api/v1/...`. A denylist written against `/me/...` that
     * does not strip that prefix matches nothing and protects nothing — the
     * failure this suite exists to catch.
     */
    it.each([
      '/api/v1/me/api-keys',
      '/api/v1/me/sessions',
      '/api/v1/me/sessions/revoke-others',
      '/api/v1/me/mfa/backup-codes/regenerate',
      '/api/v1/me/change-password',
      '/api/v1/auth/logout',
      '/api/v1/auth/mfa/enroll',
      '/api/v1/auth/step-up/verify',
    ])('denies %s', (path) => {
      expect(() => guard.canActivate(ctxFor(path, 'k-1'))).toThrow(ForbiddenException);
    });

    it.each([
      '/API/V1/ME/API-KEYS',
      '/api//v1//me//sessions',
      '/api/v1/me/api-keys/',
      '/api/v2/me/change-password',
    ])('denies %s despite casing, doubled slashes, trailing slash or version drift', (path) => {
      expect(() => guard.canActivate(ctxFor(path, 'k-1'))).toThrow(ForbiddenException);
    });

    it('denies the bare /auth path, which normalisation would otherwise strip past', () => {
      // '/auth/' with a trailing slash would miss this: normalizePath strips it.
      expect(() => guard.canActivate(ctxFor('/api/v1/auth', 'k-1'))).toThrow(
        ForbiddenException,
      );
    });

    it('denies any route marked @InteractiveOnly, whatever its path', () => {
      // The decorator is the primary control; the path denylist is a backstop
      // that cannot cover routes outside the /auth and /me trees.
      currentInteractiveOnly = true;
      expect(() => guard.canActivate(ctxFor('/api/v1/users', 'k-1'))).toThrow(
        ForbiddenException,
      );
      expect(() =>
        guard.canActivate(ctxFor('/api/v1/users/u-9/invite', 'k-1')),
      ).toThrow(ForbiddenException);
    });

    it('allows read-only self-introspection at /auth/me', () => {
      expect(guard.canActivate(ctxFor('/api/v1/auth/me', 'k-1'))).toBe(true);
    });

    it.each([
      '/api/v1/companies/c-1/assets',
      '/api/v1/layouts',
      '/api/v1/companies/c-1/domains',
      '/api/v1/search',
    ])('allows business route %s', (path) => {
      expect(guard.canActivate(ctxFor(path, 'k-1'))).toBe(true);
    });

    it('lets a key list the vault but not decrypt from it', () => {
      // Listing is metadata. Reveal decrypts, and nothing else stops it:
      // the password reveal routes carry no @RequireStepUp(), so this guard
      // is the only thing standing between a leaked key and every stored
      // client credential.
      expect(guard.canActivate(ctxFor('/api/v1/companies/c-1/passwords', 'k-1'))).toBe(
        true,
      );

      currentVaultReveal = true;
      expect(() =>
        guard.canActivate(ctxFor('/api/v1/companies/c-1/passwords/p-1/reveal', 'k-1')),
      ).toThrow(ForbiddenException);
    });

    it('permits reveal only for a key minted with allowPasswordReveal', () => {
      currentVaultReveal = true;
      expect(
        guard.canActivate(
          ctxFor('/api/v1/companies/c-1/passwords/p-1/reveal', 'k-1', false, true),
        ),
      ).toBe(true);
    });

    it('never blocks an interactive session from the vault', () => {
      currentVaultReveal = true;
      expect(
        guard.canActivate(ctxFor('/api/v1/companies/c-1/passwords/p-1/reveal')),
      ).toBe(true);
    });
  });
});
