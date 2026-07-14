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
});
