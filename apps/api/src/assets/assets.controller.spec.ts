import { AssetsController } from './assets.controller.js';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';

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
