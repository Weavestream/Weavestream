import { scanSensitiveMaterial } from './sensitive-material.js';

describe('scanSensitiveMaterial', () => {
  it('detects nested secret material', () => {
    expect(scanSensitiveMaterial({ nested: [{ accessToken: 'short' }] })).toBe('sensitive');
  });

  it('returns a stable bounds result for cycles', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    expect(scanSensitiveMaterial(value)).toBe('bounds_exceeded');
  });

  it('returns a stable bounds result beyond depth eight', () => {
    let value: Record<string, unknown> = {};
    const root = value;
    for (let index = 0; index < 9; index += 1) {
      const child: Record<string, unknown> = {};
      value.child = child;
      value = child;
    }
    expect(scanSensitiveMaterial(root)).toBe('bounds_exceeded');
  });

  it('returns a stable bounds result beyond 1024 traversed entries', () => {
    const value = Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [`field${index}`, index]),
    );
    expect(scanSensitiveMaterial(value)).toBe('bounds_exceeded');
  });

  it('fails closed when array classification touches a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable([], {});
    revoke();
    expect(scanSensitiveMaterial(proxy)).toBe('bounds_exceeded');
  });

  it('fails closed when an array index getter throws', () => {
    const value: unknown[] = [];
    Object.defineProperty(value, 0, {
      enumerable: true,
      get: () => { throw new Error('source-secret-index-text'); },
    });
    expect(scanSensitiveMaterial(value)).toBe('bounds_exceeded');
  });

  it('flags a high-entropy token even when embedded in surrounding text', () => {
    // The entropy scan inspects each token run, so a secret concatenated with a
    // whitespace or punctuation separator cannot be laundered by its neighbours.
    const secret = 'Kf9mZ2pQ7rL4wXbn6vT8cH3dSjY0aGeU4iO1kPqRtWc';
    expect(scanSensitiveMaterial(secret)).toBe('sensitive');
    expect(scanSensitiveMaterial(`device ${secret} active`)).toBe('sensitive');
    expect(scanSensitiveMaterial(`${secret}: Firewall`)).toBe('sensitive');
    expect(scanSensitiveMaterial({ note: `key = ${secret}` })).toBe('sensitive');
  });

  it('keeps benign inventory labels, digests, and large payloads safe', () => {
    expect(scanSensitiveMaterial('Main Firewall Rack 3 Building A')).toBe('safe');
    expect(scanSensitiveMaterial('edge-router-01.datacenter-west.internal.example.com')).toBe('safe');
    // SHA-256 hex digest: 16-symbol alphabet caps entropy below the threshold
    // and offers only two character classes, so digests are not secrets.
    expect(
      scanSensitiveMaterial('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
    ).toBe('safe');
    // A genuinely high-entropy blob longer than 4096 chars (a large legitimate
    // payload) stays outside the detection window.
    const bigBlob = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(70);
    expect(scanSensitiveMaterial(bigBlob)).toBe('safe');
  });
});
