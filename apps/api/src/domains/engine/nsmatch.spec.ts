import { compareNs } from './nsmatch.js';

describe('compareNs', () => {
  it('returns match when sets are equal', () => {
    const r = compareNs(
      ['ns1.example.com', 'ns2.example.com'],
      ['ns1.example.com', 'ns2.example.com'],
    );
    expect(r.status).toBe('OK');
    expect(r.data?.match).toBe('match');
  });

  it('normalises case + trailing dots + order', () => {
    const r = compareNs(
      ['NS2.example.com.', 'ns1.EXAMPLE.com'],
      ['ns1.example.com', 'ns2.example.com.'],
    );
    expect(r.data?.match).toBe('match');
  });

  it('flags mismatch when sets differ', () => {
    const r = compareNs(
      ['ns1.example.com', 'ns2.example.com'],
      ['ns1.example.com', 'ns3.example.com'],
    );
    expect(r.status).toBe('WARN');
    expect(r.data?.match).toBe('mismatch');
  });

  it('returns unverifiable as SKIP when registry side empty', () => {
    const r = compareNs(['ns1.example.com'], []);
    expect(r.status).toBe('SKIP');
    expect(r.data?.match).toBe('unverifiable');
  });

  it('flags mismatch as WARN when DNS side empty but registry has NS', () => {
    const r = compareNs([], ['ns1.example.com']);
    expect(r.status).toBe('WARN');
    expect(r.data?.match).toBe('mismatch');
  });

  it('deduplicates duplicate entries before comparing', () => {
    const r = compareNs(
      ['ns1.example.com', 'ns1.example.com', 'ns2.example.com'],
      ['ns1.example.com', 'ns2.example.com'],
    );
    expect(r.data?.match).toBe('match');
  });
});
