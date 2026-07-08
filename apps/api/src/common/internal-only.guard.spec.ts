import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import {
  INTERNAL_TOKEN_HEADER,
  deriveInternalApiToken,
} from '@weavestream/shared';
import { InternalOnlyGuard } from './internal-only.guard.js';

// A stand-in COOKIE_SIGNING_KEY; the exact value doesn't matter, only that
// the guard derives the same token from it that the test presents.
const SECRET = 'dGVzdC1jb29raWUtc2lnbmluZy1rZXktYmFzZTY0';

function ctxFor(opts: {
  remoteAddress?: string;
  token?: string | string[];
}): ExecutionContext {
  const headers: Record<string, string | string[]> = {};
  if (opts.token !== undefined) headers[INTERNAL_TOKEN_HEADER] = opts.token;
  const req = { socket: { remoteAddress: opts.remoteAddress }, headers };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function makeGuard(): InternalOnlyGuard {
  const env = { values: { COOKIE_SIGNING_KEY: SECRET } } as never;
  return new InternalOnlyGuard(env);
}

// Same length, one char different — a genuine mismatch that still exercises
// timingSafeEqual (rather than tripping the length guard).
const flipLast = (t: string) => t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');

describe('InternalOnlyGuard', () => {
  let goodToken: string;
  beforeAll(async () => {
    goodToken = await deriveInternalApiToken(SECRET);
  });

  it('allows a private peer presenting the correct derived token', async () => {
    await expect(
      makeGuard().canActivate(
        ctxFor({ remoteAddress: '172.18.0.4', token: goodToken }),
      ),
    ).resolves.toBe(true);
  });

  it('rejects a private peer with a wrong (same-length) token', async () => {
    await expect(
      makeGuard().canActivate(
        ctxFor({ remoteAddress: '172.18.0.4', token: flipLast(goodToken) }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a wrong-length token without throwing from timingSafeEqual', async () => {
    await expect(
      makeGuard().canActivate(
        ctxFor({ remoteAddress: '172.18.0.4', token: `${goodToken}extra` }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a private peer with no token header', async () => {
    await expect(
      makeGuard().canActivate(ctxFor({ remoteAddress: '172.18.0.4' })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects an array-valued token header (duplicate headers)', async () => {
    await expect(
      makeGuard().canActivate(
        ctxFor({ remoteAddress: '172.18.0.4', token: [goodToken, goodToken] }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a public (non-private) peer even with the correct token', async () => {
    await expect(
      makeGuard().canActivate(
        ctxFor({ remoteAddress: '203.0.113.9', token: goodToken }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
