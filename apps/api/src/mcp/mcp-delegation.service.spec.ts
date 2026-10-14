import { McpDelegationService } from './mcp-delegation.service.js';

const grant = { connectionId: 'c-1', userId: 'u-1', method: 'GET' as const, path: '/api/v1/companies' };

describe('McpDelegationService', () => {
  it('mints unguessable, distinct wsd_ handles', () => {
    const store = new McpDelegationService();
    const a = store.mint(grant);
    const b = store.mint(grant);
    expect(a).toMatch(/^wsd_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('a handle is taken once', () => {
    const store = new McpDelegationService();
    const handle = store.mint(grant);
    expect(store.take(handle)).toMatchObject(grant);
    expect(store.take(handle)).toBeUndefined();
  });

  it('an expired handle is refused and removed', () => {
    const store = new McpDelegationService();
    const handle = store.mint(grant);
    const real = Date.now.bind(Date);
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => real() + 30_001);
    try {
      expect(store.take(handle)).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('a released handle cannot be taken', () => {
    const store = new McpDelegationService();
    const handle = store.mint(grant);
    store.release(handle);
    expect(store.take(handle)).toBeUndefined();
  });
});
