import { createHash } from 'node:crypto';
import {
  constantTimeEqual,
  newAuthRequestSecrets,
  pkceChallenge,
  randomToken,
} from './sso-pkce.js';

describe('sso-pkce', () => {
  it('draws 43-character base64url tokens (32 random bytes)', () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats a token', () => {
    const seen = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(seen.size).toBe(200);
  });

  it('computes the RFC 7636 S256 challenge for the appendix B vector', () => {
    // RFC 7636 Appendix B.
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('builds a request whose challenge is the S256 of its own verifier', () => {
    const s = newAuthRequestSecrets();
    expect(s.challenge).toBe(createHash('sha256').update(s.verifier).digest('base64url'));
    expect(s.verifier.length).toBeGreaterThanOrEqual(43);
    expect(s.verifier.length).toBeLessThanOrEqual(128);
  });

  it('uses independent values for state, nonce and verifier', () => {
    const s = newAuthRequestSecrets();
    expect(new Set([s.state, s.nonce, s.verifier]).size).toBe(3);
  });

  describe('constantTimeEqual', () => {
    it('is true only for identical strings', () => {
      expect(constantTimeEqual('abc', 'abc')).toBe(true);
      expect(constantTimeEqual('abc', 'abd')).toBe(false);
    });

    it('handles different lengths without throwing', () => {
      expect(constantTimeEqual('abc', 'abcd')).toBe(false);
      expect(constantTimeEqual('', 'a')).toBe(false);
      expect(constantTimeEqual('', '')).toBe(true);
    });
  });
});
