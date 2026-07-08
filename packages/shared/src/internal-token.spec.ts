import { createHmac } from 'node:crypto';
import { INTERNAL_TOKEN_HEADER, deriveInternalApiToken } from './internal-token.js';

// Reference oracle: the Web Crypto HMAC in deriveInternalApiToken must
// agree byte-for-byte with node:crypto over the same fixed label. This
// pins both the algorithm (HMAC-SHA256, hex) and the label — change either
// and this fails.
const LABEL = 'weavestream:internal-api-token:v1';
const nodeToken = (secret: string): string =>
  createHmac('sha256', Buffer.from(secret, 'utf8')).update(LABEL).digest('hex');

describe('deriveInternalApiToken', () => {
  it('matches a known HMAC-SHA256 vector (Web Crypto == node:crypto)', async () => {
    const secret = 'aGVsbG8td29ybGQtc2lnbmluZy1rZXktYmFzZTY0';
    await expect(deriveInternalApiToken(secret)).resolves.toBe(nodeToken(secret));
  });

  it('is deterministic — same secret yields the same token', async () => {
    const secret = 'ZGV0ZXJtaW5pc3RpYy1zZWNyZXQ=';
    const a = await deriveInternalApiToken(secret);
    const b = await deriveInternalApiToken(secret);
    expect(a).toBe(b);
  });

  it('different secrets produce different tokens', async () => {
    const a = await deriveInternalApiToken('secret-one');
    const b = await deriveInternalApiToken('secret-two');
    expect(a).not.toBe(b);
  });

  it('produces a 64-char lowercase hex digest', async () => {
    const token = await deriveInternalApiToken('any-secret');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('exposes the header name web and api agree on', () => {
    expect(INTERNAL_TOKEN_HEADER).toBe('x-ws-internal-token');
  });
});
