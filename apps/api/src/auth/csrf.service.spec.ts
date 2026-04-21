import { CsrfService } from './csrf.service.js';
import { EnvService } from '../config/env.service.js';

function makeEnv(): EnvService {
  const env = Object.create(EnvService.prototype) as EnvService;
  (env as unknown as { values: unknown }).values = {
    CSRF_SIGNING_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
  return env;
}

describe('CsrfService', () => {
  const svc = new CsrfService(makeEnv());

  it('issues a token that verifies', () => {
    const token = svc.issue();
    expect(svc.verify(token)).toBe(true);
  });

  it('rejects tampered tokens', () => {
    const token = svc.issue();
    const tampered = token.slice(0, -4) + 'AAAA';
    expect(svc.verify(tampered)).toBe(false);
  });

  it('match() requires header and cookie tokens to be equal and signed', () => {
    const token = svc.issue();
    expect(svc.match(token, token)).toBe(true);
    expect(svc.match(token, svc.issue())).toBe(false);
    expect(svc.match(undefined, token)).toBe(false);
    expect(svc.match(token, undefined)).toBe(false);
  });
});
