import { computeHibpRangeHash } from './hibp-range-hash.js';

/**
 * Locks the HIBP range hash to the exact format the public API expects:
 * uppercase hex SHA-1 of the UTF-8 plaintext. Test vectors are taken
 * directly from HIBP documentation examples.
 */
describe('computeHibpRangeHash', () => {
  it("produces uppercase hex SHA-1 for 'P@ssw0rd'", () => {
    expect(computeHibpRangeHash('P@ssw0rd')).toBe(
      '21BD12DC183F740EE76F27B78EB39C8AD972A757',
    );
  });

  it("produces uppercase hex SHA-1 for 'password'", () => {
    expect(computeHibpRangeHash('password')).toBe(
      '5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8',
    );
  });

  it('returns a 40-character uppercase hex string', () => {
    const hash = computeHibpRangeHash('any-secret-value');
    expect(hash).toMatch(/^[0-9A-F]{40}$/);
  });

  it('handles unicode via UTF-8 encoding', () => {
    expect(computeHibpRangeHash('päss🔒')).toBe(
      computeHibpRangeHash('päss🔒'),
    );
    expect(computeHibpRangeHash('a').length).toBe(40);
  });
});
