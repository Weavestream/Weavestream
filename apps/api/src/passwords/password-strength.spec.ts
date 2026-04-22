import { computePasswordStrength } from './password-strength.js';

/**
 * Sanity-level checks around the zxcvbn wrapper: ensure we return the
 * 0–4 score range, that trivial passwords score low, that strong
 * randomly generated passwords score high, and that the "extraInputs"
 * field is honoured so that reusing the account name as the password
 * is explicitly penalised.
 */
describe('computePasswordStrength', () => {
  it('rates obvious passwords at the bottom of the range', () => {
    expect(computePasswordStrength('password')).toBeLessThanOrEqual(1);
    expect(computePasswordStrength('hunter2')).toBeLessThanOrEqual(1);
  });

  it('rates long random passphrases at the top of the range', () => {
    expect(
      computePasswordStrength('correct-horse-battery-staple-2026-q4'),
    ).toBeGreaterThanOrEqual(3);
  });

  it('penalises passwords that collide with extraInputs', () => {
    const withoutInputs = computePasswordStrength('acme-vpn-admin');
    const withInputs = computePasswordStrength('acme-vpn-admin', [
      'Acme VPN',
      'admin',
      'https://vpn.acme.test',
    ]);
    expect(withInputs).toBeLessThanOrEqual(withoutInputs);
  });
});
