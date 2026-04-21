import { BadRequestException } from '@nestjs/common';
import type { Upload } from '@prisma/client';
import { UploadsService } from './uploads.service.js';

function baseUpload(over: Partial<Upload> = {}): Upload {
  return {
    id: 'u1',
    companyId: 'c1',
    uploaderId: 'user-1',
    filename: 'a.zip',
    mimeType: 'application/zip',
    sizeBytes: 100,
    storageKey: 'k1',
    sha256: 'abc',
    isImage: false,
    width: null,
    height: null,
    thumbnailKey: null,
    attachedToType: 'asset',
    attachedToId: 'a1',
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  };
}

describe('UploadsService.listAttachments', () => {
  let findMany: jest.Mock;
  let service: UploadsService;

  beforeEach(() => {
    const uploads: Upload[] = [
      baseUpload({ id: 'u-img', isImage: true, filename: 'x.png', mimeType: 'image/png' }),
      baseUpload({ id: 'u-doc', isImage: false, filename: 'y.zip' }),
    ];
    findMany = jest.fn().mockImplementation(async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      return uploads.filter((u) => {
        if (w.companyId && u.companyId !== w.companyId) return false;
        if (w.deletedAt === null && u.deletedAt !== null) return false;
        if (w.attachedToType && u.attachedToType !== w.attachedToType) return false;
        if (w.attachedToId && u.attachedToId !== w.attachedToId) return false;
        return true;
      });
    });

    const prisma = { upload: { findMany } };
    const storage = {
      presignGet: jest.fn().mockResolvedValue({ url: 'https://signed.example/obj' }),
      presignPut: jest.fn(),
      headObject: jest.fn(),
      getObjectBody: jest.fn(),
      deleteObject: jest.fn(),
      putObject: jest.fn(),
      uploadKey: jest.fn(),
      thumbnailKey: jest.fn(),
    };
    const redis = { client: { get: jest.fn(), set: jest.fn(), del: jest.fn() } };
    const audit = { log: jest.fn() };
    const env = {
      values: {
        MAX_UPLOAD_MB: 25,
        ALLOWED_UPLOAD_MIME: 'image/png,application/zip',
      },
    };

    service = new UploadsService(
      prisma as never,
      storage as never,
      redis as never,
      audit as never,
      env as never,
    );
  });

  it('rejects when attachedToId is empty', async () => {
    await expect(
      service.listAttachments('c1', {
        attachedToType: 'asset',
        attachedToId: '',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns images and non-images for the entity (no isImage filter)', async () => {
    const res = await service.listAttachments('c1', {
      attachedToType: 'asset',
      attachedToId: 'a1',
      limit: 10,
    });
    expect(res.items).toHaveLength(2);
    expect(res.items.map((i) => i.id).sort()).toEqual(['u-doc', 'u-img']);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          companyId: 'c1',
          deletedAt: null,
          attachedToType: 'asset',
          attachedToId: 'a1',
        }),
      }),
    );
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('isImage');
  });
});
