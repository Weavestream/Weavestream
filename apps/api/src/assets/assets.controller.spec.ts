import { AssetsController } from './assets.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';
import { INTERACTIVE_ONLY_KEY } from '../auth/interactive-only.decorator.js';

/**
 * Pins the authorization configuration of the destructive asset routes
 * (WS-015). Purge is irreversible, so both the single-item and bulk
 * handlers must carry `asset.purge` (FULL access) AND a step-up
 * re-authentication challenge. Metadata assertions catch a decorator
 * being dropped in a refactor without booting the Nest app.
 */
describe('AssetsController purge route metadata', () => {
  function metadataOf(key: string, handler: string): unknown {
    return Reflect.getMetadata(
      key,
      AssetsController.prototype[handler as keyof AssetsController] as object,
    );
  }

  it.each(['purge', 'bulkPurge'])(
    '%s requires the asset.purge permission scoped to the route company',
    (handler) => {
      expect(metadataOf(REQUIRE_PERMISSION_KEY, handler)).toEqual({
        action: 'asset.purge',
        companyIdFrom: 'params.companyId',
      });
    },
  );

  it.each(['purge', 'bulkPurge'])(
    '%s requires step-up re-authentication',
    (handler) => {
      // Unconditional challenge: no `when` predicate — purge is always
      // destructive.
      expect(metadataOf(REQUIRE_STEP_UP_KEY, handler)).toEqual({});
    },
  );
});

describe('AssetsController CSV export', () => {
  const COMPANY = '00000000-0000-4000-8000-000000000001';
  const LAYOUT = '00000000-0000-4000-8000-000000000002';
  const TAG = '00000000-0000-4000-8000-000000000003';
  const actor = { id: 'u1', role: 'TECHNICIAN' } as never;
  const req = { ip: '127.0.0.1', headers: { 'user-agent': 'jest' } } as never;

  function handlerMeta(key: string): unknown {
    return Reflect.getMetadata(key, AssetsController.prototype.exportCsv as object);
  }

  function setup(result = { filename: 'acme-servers-2026-11-04.csv', csv: '﻿"Name"\r\n', rowCount: 0, truncated: false }) {
    const exportCsv = jest.fn().mockResolvedValue(result);
    const controller = new AssetsController({ exportCsv } as never, {} as never);
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as never;
    return { controller, exportCsv, headers, res };
  }

  it('requires asset.read scoped to the route company', () => {
    expect(handlerMeta(REQUIRE_PERMISSION_KEY)).toEqual({
      action: 'asset.read',
      companyIdFrom: 'params.companyId',
    });
  });

  it('is throttled to 10 exports per minute', () => {
    expect(handlerMeta('THROTTLER:LIMITglobal')).toBe(10);
    expect(handlerMeta('THROTTLER:TTLglobal')).toBe(60_000);
  });

  it('is declared before the :id route so "export" is not read as an id', () => {
    const names = Object.getOwnPropertyNames(AssetsController.prototype);
    expect(names.indexOf('exportCsv')).toBeGreaterThan(-1);
    expect(names.indexOf('exportCsv')).toBeLessThan(names.indexOf('get'));
  });

  it('passes the parsed filters and sets the download headers', async () => {
    const { controller, exportCsv, headers, res } = setup({
      filename: 'acme-servers-2026-11-04.csv',
      csv: 'x',
      rowCount: 1,
      truncated: true,
    });
    await controller.exportCsv(
      actor,
      COMPANY,
      { layout: LAYOUT, q: ['a', 'b'], includeArchived: 'true', tag: TAG, columns: 'all' },
      req,
      res,
    );
    expect(exportCsv).toHaveBeenCalledWith(
      actor,
      COMPANY,
      { layoutId: LAYOUT, q: ['a', 'b'], includeArchived: true, tagId: TAG, columns: 'all' },
      expect.anything(),
    );
    expect(headers['Content-Type']).toBe('text/csv; charset=utf-8');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Disposition']).toContain('attachment; filename="acme-servers-2026-11-04.csv"');
    expect(headers['X-Export-Truncated']).toBe('true');
  });

  it('defaults to the table columns and omits the truncated header', async () => {
    const { controller, exportCsv, headers, res } = setup();
    await controller.exportCsv(actor, COMPANY, { layout: LAYOUT }, req, res);
    expect(exportCsv.mock.calls[0][2]).toMatchObject({ columns: 'table', includeArchived: false });
    expect(headers['X-Export-Truncated']).toBeUndefined();
  });

  it.each([
    ['a missing layout', {}],
    ['a non-uuid layout', { layout: 'servers' }],
    ['a non-uuid tag', { layout: LAYOUT, tag: 'pw:prod' }],
    ['an unknown column mode', { layout: LAYOUT, columns: 'everything' }],
  ])('rejects %s with 400', async (_label, query) => {
    const { controller, exportCsv, res } = setup();
    await expect(controller.exportCsv(actor, COMPANY, query, req, res)).rejects.toMatchObject({
      status: 400,
    });
    expect(exportCsv).not.toHaveBeenCalled();
  });
});

describe('AssetsController version history routes', () => {
  const COMPANY = '00000000-0000-4000-8000-000000000001';
  const ASSET = '00000000-0000-4000-8000-0000000000a1';
  const actor = { id: 'u1', role: 'OPERATOR' } as never;
  const req = { ip: '127.0.0.1', headers: { 'user-agent': 'jest' } } as never;

  const metaOf = (key: string, handler: keyof AssetsController): unknown =>
    Reflect.getMetadata(key, AssetsController.prototype[handler] as object);

  it('redact is erasure: asset.purge, step-up, human session only, rate limited', () => {
    expect(metaOf(REQUIRE_PERMISSION_KEY, 'redactVersions')).toEqual({
      action: 'asset.purge',
      companyIdFrom: 'params.companyId',
    });
    expect(metaOf(REQUIRE_STEP_UP_KEY, 'redactVersions')).toEqual({});
    expect(metaOf(INTERACTIVE_ONLY_KEY, 'redactVersions')).toBe(true);
    expect(metaOf('THROTTLER:LIMITglobal', 'redactVersions')).toBe(10);
    expect(metaOf('THROTTLER:TTLglobal', 'redactVersions')).toBe(60_000);
  });

  it.each(['versions', 'version'] as const)('%s needs asset.read on the route company', (handler) => {
    expect(metaOf(REQUIRE_PERMISSION_KEY, handler)).toEqual({
      action: 'asset.read',
      companyIdFrom: 'params.companyId',
    });
  });

  it('restore needs asset.write (same as editing)', () => {
    expect(metaOf(REQUIRE_PERMISSION_KEY, 'restoreVersion')).toEqual({
      action: 'asset.write',
      companyIdFrom: 'params.companyId',
    });
  });

  it('declares redact before the :version routes so "redact" is never a version number', () => {
    const names = Object.getOwnPropertyNames(AssetsController.prototype);
    expect(names.indexOf('redactVersions')).toBeLessThan(names.indexOf('version'));
  });

  it('delegates list, detail and redact with the actor and company from the route', async () => {
    const svc = {
      listVersions: jest.fn().mockResolvedValue('list'),
      getVersion: jest.fn().mockResolvedValue('detail'),
      redactVersions: jest.fn().mockResolvedValue({ versionsRedacted: 2 }),
    };
    const c = new AssetsController(svc as never, {} as never);
    await c.versions(actor, COMPANY, ASSET, { limit: 5, cursor: 9 });
    expect(svc.listVersions).toHaveBeenCalledWith(actor, COMPANY, ASSET, { limit: 5, cursor: 9 });
    await c.version(actor, COMPANY, ASSET, 3);
    expect(svc.getVersion).toHaveBeenCalledWith(actor, COMPANY, ASSET, 3);
    await expect(c.redactVersions(actor, COMPANY, ASSET, { version: 2 }, req)).resolves.toEqual({
      versionsRedacted: 2,
    });
    expect(svc.redactVersions).toHaveBeenCalledWith(
      actor,
      COMPANY,
      ASSET,
      { version: 2 },
      expect.objectContaining({ ip: expect.anything() }),
    );
  });
});
