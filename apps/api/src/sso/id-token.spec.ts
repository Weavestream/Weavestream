import { SignJWT, generateKeyPair, type CryptoKey, type JWTPayload } from 'jose';
import { IdTokenError, verifyIdToken, type IdTokenFailure } from './id-token.js';

// A locally generated key pair stands in for the identity provider's keys.
// Nothing here is a real credential.
const ISSUER = 'https://login.example.test/11111111-2222-3333-4444-555555555555/v2.0';
const CLIENT_ID = 'client-abc';
const NONCE = 'nonce-value-for-this-request';
const TENANT = '11111111-2222-3333-4444-555555555555';

let privateKey: CryptoKey;
let publicKey: CryptoKey;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair('RS256'));
  ({ privateKey: otherPrivateKey } = await generateKeyPair('RS256'));
});

const getKey = async () => publicKey;

function sign(
  claims: JWTPayload = {},
  opts: { key?: CryptoKey; alg?: string; exp?: string | number; iss?: string; aud?: string | string[] } = {},
): Promise<string> {
  const jwt = new SignJWT({ nonce: NONCE, tid: TENANT, oid: 'oid-1', ...claims })
    .setProtectedHeader({ alg: opts.alg ?? 'RS256' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setSubject('sub-1')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m');
  return jwt.sign(opts.key ?? privateKey);
}

const verify = (token: string, extra: { allowedTenantId?: string } = {}) =>
  verifyIdToken(token, getKey, { issuer: ISSUER, clientId: CLIENT_ID, nonce: NONCE, ...extra });

async function failureOf(p: Promise<unknown>): Promise<IdTokenFailure> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(IdTokenError);
  return (err as IdTokenError).failure;
}

describe('verifyIdToken', () => {
  it('accepts a good token and returns only the claims we use', async () => {
    const out = await verify(
      await sign({
        email: 'User@Example.com',
        preferred_username: 'user@example.com',
        name: 'A User',
        amr: ['pwd', 'mfa'],
        auth_time: 1_700_000_000,
        secret_extra_claim: 'must-not-leak',
      }),
    );
    expect(out).toEqual({
      issuer: ISSUER,
      sub: 'sub-1',
      oid: 'oid-1',
      tid: TENANT,
      email: 'User@Example.com',
      emailVerified: false,
      emailDomainOwnerVerified: false,
      name: 'A User',
      amr: ['pwd', 'mfa'],
      authTime: 1_700_000_000,
    });
  });

  it('treats an absent or false email_verified as NOT verified, and only true as verified', async () => {
    expect((await verify(await sign({ email: 'a@b.test' }))).emailVerified).toBe(false);
    expect((await verify(await sign({ email: 'a@b.test', email_verified: false }))).emailVerified).toBe(false);
    expect((await verify(await sign({ email: 'a@b.test', email_verified: 'yes' }))).emailVerified).toBe(false);
    expect((await verify(await sign({ email: 'a@b.test', email_verified: true }))).emailVerified).toBe(true);
  });

  it('reads the Entra xms_edov claim (true only; absent is not verified)', async () => {
    expect((await verify(await sign())).emailDomainOwnerVerified).toBe(false);
    expect((await verify(await sign({ xms_edov: false }))).emailDomainOwnerVerified).toBe(false);
    expect((await verify(await sign({ xms_edov: true }))).emailDomainOwnerVerified).toBe(true);
  });

  it('defaults amr to an empty list and ignores non-string entries', async () => {
    expect((await verify(await sign())).amr).toEqual([]);
    expect((await verify(await sign({ amr: ['mfa', 7, null] }))).amr).toEqual(['mfa']);
  });

  it('rejects a token signed with a different key', async () => {
    expect(await failureOf(verify(await sign({}, { key: otherPrivateKey })))).toBe('invalid_token');
  });

  it('rejects the wrong issuer', async () => {
    const token = await sign({}, { iss: 'https://evil.example.test/v2.0' });
    expect(await failureOf(verify(token))).toBe('invalid_token');
  });

  it('rejects the wrong audience', async () => {
    expect(await failureOf(verify(await sign({}, { aud: 'someone-else' })))).toBe('invalid_token');
  });

  it('accepts a multi-audience token only when azp names this client', async () => {
    const aud = [CLIENT_ID, 'other'];
    expect(await verify(await sign({ azp: CLIENT_ID }, { aud }))).toMatchObject({ sub: 'sub-1' });
    expect(await failureOf(verify(await sign({ azp: 'other' }, { aud })))).toBe('invalid_token');
  });

  it('rejects the wrong nonce', async () => {
    expect(await failureOf(verify(await sign({ nonce: 'a-different-nonce' })))).toBe(
      'nonce_mismatch',
    );
  });

  it('rejects a token with no nonce', async () => {
    const token = await new SignJWT({ tid: TENANT })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject('sub-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(await failureOf(verify(token))).toBe('nonce_mismatch');
  });

  it('rejects an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject('sub-1')
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(privateKey);
    expect(await failureOf(verify(token))).toBe('expired');
  });

  it('rejects alg=none', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'sub-1',
      nonce: NONCE,
      iat: now,
      exp: now + 300,
    })}.`;
    expect(await failureOf(verify(token))).toBe('invalid_token');
  });

  it('rejects an HS256 token (the public-key-as-HMAC-secret downgrade)', async () => {
    const hmacKey = new TextEncoder().encode('0123456789abcdef0123456789abcdef');
    const token = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setSubject('sub-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(hmacKey);
    expect(await failureOf(verify(token))).toBe('invalid_token');
  });

  it('rejects a token without sub, iat or exp', async () => {
    const token = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .sign(privateKey);
    expect(await failureOf(verify(token))).toBe('invalid_token');
  });

  it('rejects garbage', async () => {
    expect(await failureOf(verify('not-a-jwt'))).toBe('invalid_token');
  });

  describe('tenant pin', () => {
    it('accepts the pinned tenant (case-insensitively)', async () => {
      const out = await verify(await sign(), { allowedTenantId: TENANT.toUpperCase() });
      expect(out.tid).toBe(TENANT);
    });

    it('rejects a different tenant', async () => {
      const token = await sign({ tid: '99999999-9999-9999-9999-999999999999' });
      expect(await failureOf(verify(token, { allowedTenantId: TENANT }))).toBe('tenant_mismatch');
    });

    it('rejects a token with no tid when a tenant is pinned', async () => {
      const token = await new SignJWT({ nonce: NONCE })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject('sub-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      expect(await failureOf(verify(token, { allowedTenantId: TENANT }))).toBe('tenant_mismatch');
    });

    it('does not require tid when nothing is pinned', async () => {
      const token = await new SignJWT({ nonce: NONCE })
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject('sub-1')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      expect((await verify(token)).tid).toBeUndefined();
    });
  });
});
