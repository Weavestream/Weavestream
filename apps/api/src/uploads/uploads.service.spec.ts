import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Readable } from 'node:stream';
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

describe('UploadsService.init / relayPut', () => {
  type Storage = {
    presignGet: jest.Mock;
    presignPut: jest.Mock;
    headObject: jest.Mock;
    getObjectBody: jest.Mock;
    deleteObject: jest.Mock;
    putObject: jest.Mock;
    uploadKey: jest.Mock;
    thumbnailKey: jest.Mock;
    ensureBucket: jest.Mock;
  };
  type RedisClient = {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };

  let storage: Storage;
  let redis: { client: RedisClient };
  let service: UploadsService;
  const actor = { id: 'user-1' } as never;

  beforeEach(() => {
    storage = {
      presignGet: jest.fn(),
      presignPut: jest.fn(),
      headObject: jest.fn(),
      getObjectBody: jest.fn(),
      deleteObject: jest.fn(),
      putObject: jest.fn().mockResolvedValue(undefined),
      uploadKey: jest
        .fn()
        .mockImplementation(
          (cid: string, uid: string, name: string) =>
            `company/${cid}/uploads/${uid}/${name}`,
        ),
      thumbnailKey: jest.fn(),
      ensureBucket: jest.fn().mockResolvedValue('weavestream-c1'),
    };
    redis = {
      client: {
        get: jest.fn(),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn(),
      },
    };
    const env = {
      values: { MAX_UPLOAD_MB: 1, ALLOWED_UPLOAD_MIME: 'image/png,application/zip' },
    };
    service = new UploadsService(
      { upload: {} } as never,
      storage as never,
      redis as never,
      { log: jest.fn() } as never,
      env as never,
    );
  });

  it('init returns a same-origin relay URL and primes the bucket', async () => {
    const res = await service.init(actor, 'c1', {
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
    } as never);
    expect(storage.ensureBucket).toHaveBeenCalledWith('c1');
    expect(storage.presignPut).not.toHaveBeenCalled();
    expect(res.presignedUrl).toBe(
      `/api/v1/companies/c1/uploads/${res.uploadId}/blob`,
    );
    expect(redis.client.set).toHaveBeenCalledWith(
      `upload:pending:${res.uploadId}`,
      expect.any(String),
      'EX',
      expect.any(Number),
    );
  });

  it('relayPut streams the body to MinIO when the pending session matches', async () => {
    redis.client.get.mockResolvedValue(
      JSON.stringify({
        companyId: 'c1',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        storageKey: 'company/c1/uploads/u-1/a.png',
        uploaderId: 'user-1',
        attachedToType: null,
        attachedToId: null,
      }),
    );
    const body = Readable.from(Buffer.from('hello'));
    await service.relayPut(actor, 'c1', 'u-1', body, {
      contentType: 'image/png',
      contentLength: 5,
    });
    expect(storage.putObject).toHaveBeenCalledWith(
      'c1',
      'company/c1/uploads/u-1/a.png',
      Buffer.from('hello'),
      { contentType: 'image/png' },
    );
  });

  it('relayPut rejects when no pending session exists', async () => {
    redis.client.get.mockResolvedValue(null);
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.alloc(0)), {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('relayPut rejects when the company scope mismatches', async () => {
    redis.client.get.mockResolvedValue(
      JSON.stringify({
        companyId: 'OTHER',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        storageKey: 'k',
        uploaderId: 'user-1',
        attachedToType: null,
        attachedToId: null,
      }),
    );
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.alloc(0)), {}),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('relayPut rejects when the session belongs to a different uploader', async () => {
    redis.client.get.mockResolvedValue(
      JSON.stringify({
        companyId: 'c1',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        storageKey: 'k',
        uploaderId: 'someone-else',
        attachedToType: null,
        attachedToId: null,
      }),
    );
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.alloc(0)), {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('relayPut rejects when the declared content-length exceeds the limit', async () => {
    redis.client.get.mockResolvedValue(
      JSON.stringify({
        companyId: 'c1',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        storageKey: 'k',
        uploaderId: 'user-1',
        attachedToType: null,
        attachedToId: null,
      }),
    );
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.alloc(0)), {
        contentLength: 10 * 1024 * 1024, // 10 MB > 1 MB cap
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('relayPut rejects when the streamed body exceeds the limit even if header lies', async () => {
    redis.client.get.mockResolvedValue(
      JSON.stringify({
        companyId: 'c1',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        storageKey: 'k',
        uploaderId: 'user-1',
        attachedToType: null,
        attachedToId: null,
      }),
    );
    const oversize = Buffer.alloc(2 * 1024 * 1024); // 2 MB > 1 MB cap
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(oversize), {
        contentLength: 5,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(storage.putObject).not.toHaveBeenCalled();
  });
});
