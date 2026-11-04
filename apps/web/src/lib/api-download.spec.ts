/** @jest-environment jsdom */
import { downloadApiFile, filenameFromContentDisposition } from './api';

describe('filenameFromContentDisposition', () => {
  it('prefers the RFC 5987 filename* over the ASCII fallback', () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename="caf_-devices-2026-11-04.csv"; filename*=UTF-8''caf%C3%A9-devices-2026-11-04.csv`,
      ),
    ).toBe('café-devices-2026-11-04.csv');
  });

  it('uses the quoted or bare filename when filename* is absent', () => {
    expect(filenameFromContentDisposition('attachment; filename="acme-devices.csv"')).toBe(
      'acme-devices.csv',
    );
    expect(filenameFromContentDisposition('attachment; filename=acme.csv')).toBe('acme.csv');
  });

  it('falls back to the plain filename when filename* is malformed', () => {
    expect(
      filenameFromContentDisposition(`attachment; filename="acme.csv"; filename*=UTF-8''bad%E0%A4`),
    ).toBe('acme.csv');
  });

  it('replaces path separators', () => {
    expect(filenameFromContentDisposition(`attachment; filename*=UTF-8''..%2F..%2Fx.csv`)).toBe(
      '.._.._x.csv',
    );
  });

  it('returns null when there is no usable name', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('attachment')).toBeNull();
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull();
  });
});

describe('downloadApiFile', () => {
  const realFetch = global.fetch;
  let downloads: string[];

  beforeEach(() => {
    downloads = [];
    URL.createObjectURL = jest.fn(() => 'blob:test');
    URL.revokeObjectURL = jest.fn();
    jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function respond(headers: Record<string, string>, status = 200) {
    global.fetch = jest.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      blob: async () => new Blob(['x']),
      json: async () => ({ detail: 'Pick a layout to export.' }),
    })) as unknown as typeof fetch;
  }

  it('saves under the server name, so the company stays in the file name', async () => {
    respond({
      'content-disposition': `attachment; filename="acme-devices-2026-11-04.csv"; filename*=UTF-8''acme-devices-2026-11-04.csv`,
      'x-export-truncated': 'true',
    });
    const res = await downloadApiFile('/companies/c/assets/export', 'devices-2026-11-04.csv');
    expect(res).toEqual({ ok: true, truncated: true });
    expect(downloads).toEqual(['acme-devices-2026-11-04.csv']);
  });

  it('uses the fallback name when the response names no file', async () => {
    respond({});
    const res = await downloadApiFile('/companies/c/assets/export', 'devices-2026-11-04.csv');
    expect(res).toEqual({ ok: true, truncated: false });
    expect(downloads).toEqual(['devices-2026-11-04.csv']);
  });

  it('downloads nothing and returns the problem on an error', async () => {
    respond({ 'content-type': 'application/problem+json' }, 400);
    const res = await downloadApiFile('/companies/c/assets/export', 'x.csv');
    expect(res).toEqual({ ok: false, status: 400, problem: { detail: 'Pick a layout to export.' } });
    expect(downloads).toEqual([]);
  });
});
