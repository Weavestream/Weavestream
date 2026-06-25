import { NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { UploadsController } from './uploads.controller.js';
import type { UploadsService } from './uploads.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

type ImageStream = NonNullable<
  Awaited<ReturnType<UploadsService['openImageStream']>>
>;

function streamOf(over: Partial<ImageStream> = {}): ImageStream {
  return {
    body: (async function* () {
      yield new Uint8Array([1, 2, 3]);
    })(),
    contentType: 'application/octet-stream',
    filename: 'file.bin',
    ...over,
  };
}

function fakeRes(): Response & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader(name: string, value: string | number) {
      headers[name.toLowerCase()] = String(value);
      return this;
    },
  } as unknown as Response & { headers: Record<string, string> };
}

const actor = { id: 'user-1' } as AuthedUser;

describe('UploadsController.image disposition + cache policy', () => {
  let openImageStream: jest.Mock;
  let controller: UploadsController;

  function setup(stream: ImageStream | null) {
    openImageStream = jest.fn().mockResolvedValue(stream);
    controller = new UploadsController({
      openImageStream,
    } as unknown as UploadsService);
  }

  it('serves an image original inline and disk-cacheable', async () => {
    setup(streamOf({ contentType: 'image/png', filename: 'photo.png' }));
    const res = fakeRes();

    await controller.image(actor, 'c1', 'u1', res, undefined, undefined);

    expect(openImageStream).toHaveBeenCalledWith('c1', 'u1', 'original', actor);
    expect(res.headers['content-disposition']).toContain('inline;');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves the thumbnail variant inline and disk-cacheable', async () => {
    setup(streamOf({ contentType: 'image/webp', filename: 'photo.png' }));
    const res = fakeRes();

    await controller.image(actor, 'c1', 'u1', res, 'thumb', undefined);

    expect(openImageStream).toHaveBeenCalledWith('c1', 'u1', 'thumb', actor);
    expect(res.headers['content-disposition']).toContain('inline;');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
  });

  it.each([
    ['application/pdf', 'doc.pdf'],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'report.docx',
    ],
    ['application/zip', 'bundle.zip'],
    ['text/x-shellscript', 'deploy.sh'],
    ['application/json', 'config.json'],
    ['text/plain', 'notes.txt'],
  ])(
    'forces attachment + no-store for non-image %s',
    async (contentType, filename) => {
      setup(streamOf({ contentType, filename }));
      const res = fakeRes();

      await controller.image(actor, 'c1', 'u1', res, undefined, undefined);

      expect(res.headers['content-disposition']).toContain('attachment;');
      expect(res.headers['content-disposition']).toContain(filename);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    },
  );

  it('honours attachment=1 for images (forced download, still cacheable)', async () => {
    setup(streamOf({ contentType: 'image/png', filename: 'photo.png' }));
    const res = fakeRes();

    await controller.image(actor, 'c1', 'u1', res, undefined, '1');

    expect(res.headers['content-disposition']).toContain('attachment;');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
  });

  it('propagates content-length / last-modified / etag when present', async () => {
    setup(
      streamOf({
        contentType: 'image/png',
        filename: 'photo.png',
        contentLength: 42,
        lastModified: new Date('2026-01-01T00:00:00Z'),
        etag: '"abc"',
      }),
    );
    const res = fakeRes();

    await controller.image(actor, 'c1', 'u1', res, undefined, undefined);

    expect(res.headers['content-length']).toBe('42');
    expect(res.headers['last-modified']).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(res.headers['etag']).toBe('"abc"');
  });

  it('404s with a variant-specific error when the stream is missing', async () => {
    setup(null);
    await expect(
      controller.image(actor, 'c1', 'u1', fakeRes(), 'thumb', undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      controller.image(actor, 'c1', 'u1', fakeRes(), undefined, undefined),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
