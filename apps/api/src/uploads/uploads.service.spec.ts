import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Upload } from '@prisma/client';
import sharp from 'sharp';
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
      headObject: jest.fn(),
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
    headObject: jest.Mock;
    putObjectStream: jest.Mock;
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
      headObject: jest.fn(),
      putObjectStream: jest.fn().mockResolvedValue(undefined),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      putObject: jest.fn().mockResolvedValue(undefined),
      uploadKey: jest
        .fn()
        .mockImplementation(
          (cid: string, uid: string, name: string) =>
            `${cid}/uploads/${uid}/${name}`,
        ),
      thumbnailKey: jest.fn(),
      ensureBucket: jest.fn().mockResolvedValue('/var/lib/weavestream/files/c1'),
    };
    redis = {
      client: {
        get: jest.fn(),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(undefined),
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

  it('init returns a same-origin relay URL and primes the tenant directory', async () => {
    const res = await service.init(actor, 'c1', {
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
    } as never);
    expect(storage.ensureBucket).toHaveBeenCalledWith('c1');
    expect(res.relayUrl).toBe(
      `/api/v1/companies/c1/uploads/${res.uploadId}/blob`,
    );
    expect(redis.client.set).toHaveBeenCalledWith(
      `upload:pending:${res.uploadId}`,
      expect.any(String),
      'EX',
      expect.any(Number),
    );
  });

  it('relayPut streams the body to local storage when the pending session matches', async () => {
    redis.client.get.mockResolvedValue(
      JSON.stringify({
        companyId: 'c1',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        storageKey: 'c1/uploads/u-1/a.png',
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
    // The body streams straight to storage (never buffered in the
    // service) with a byte-counted ceiling derived from MAX_UPLOAD_MB.
    expect(storage.putObjectStream).toHaveBeenCalledWith(
      'c1',
      'c1/uploads/u-1/a.png',
      body,
      { contentType: 'image/png', maxBytes: 1024 * 1024 },
    );
    // Write-once slot is claimed (NX), then marked done.
    expect(redis.client.set).toHaveBeenCalledWith(
      'upload:body:u-1',
      'writing',
      'EX',
      15 * 60,
      'NX',
    );
    expect(redis.client.set).toHaveBeenCalledWith(
      'upload:body:u-1',
      'done',
      'EX',
      15 * 60,
    );
  });

  it('relayPut rejects when no pending session exists', async () => {
    redis.client.get.mockResolvedValue(null);
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.alloc(0)), {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.putObjectStream).not.toHaveBeenCalled();
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

  it('relayPut fails closed when the pending session has no uploaderId', async () => {
    // init always records the uploader, so a missing id means a
    // malformed/tampered session — never "allow anyone" (WS-013).
    redis.client.get.mockResolvedValue(
      JSON.stringify({
        companyId: 'c1',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        storageKey: 'k',
        uploaderId: null,
        attachedToType: null,
        attachedToId: null,
      }),
    );
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.alloc(0)), {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.putObjectStream).not.toHaveBeenCalled();
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

  it('relayPut surfaces the storage size-limit rejection (enforced while streaming)', async () => {
    // Byte-level enforcement now lives in putObjectStream (covered in the
    // local-storage spec); relayPut must surface it rather than trusting
    // a (possibly lying) Content-Length.
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
    storage.putObjectStream.mockRejectedValue(
      new PayloadTooLargeException({ error: 'FileTooLarge' }),
    );
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.from('x')), {
        contentLength: 5,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    // Slot released so a corrected retry can re-claim it.
    expect(redis.client.del).toHaveBeenCalledWith('upload:body:u-1');
  });

  it('relayPut rejects a second PUT once the body slot is claimed (write-once)', async () => {
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
    redis.client.set.mockResolvedValueOnce(null); // NX claim loses the race
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.from('x')), {}),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(storage.putObjectStream).not.toHaveBeenCalled();
  });

  it('relayPut maps a client abort to a 400, not a server error', async () => {
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
    const body = new Readable({ read() {} });
    storage.putObjectStream.mockImplementation(async () => {
      body.emit('aborted');
      throw new Error('premature close');
    });
    await expect(
      service.relayPut(actor, 'c1', 'u-1', body, {}),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(redis.client.del).toHaveBeenCalledWith('upload:body:u-1');
  });

  it('relayPut bubbles a storage write error instead of labeling it a client abort', async () => {
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
    const fsError = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    storage.putObjectStream.mockRejectedValue(fsError);
    await expect(
      service.relayPut(actor, 'c1', 'u-1', Readable.from(Buffer.from('x')), {}),
    ).rejects.toBe(fsError);
    expect(redis.client.del).toHaveBeenCalledWith('upload:body:u-1');
  });
});

/**
 * Exercises the article-upload link-state classifier that drives the
 * photos gallery badges and the photos-page delete gate. We mock
 * `$queryRaw` directly so we can exercise the priority resolution
 * (`live` > `versioned` > `archived` > `orphan`) without standing up a
 * full Prisma + Postgres harness.
 */
describe('UploadsService.classifyArticleUploads', () => {
  type LiveHit = {
    id: string;
    slug: string;
    title: string;
    archived_at: Date | null;
    content_text: string | null;
    markdown_source: string | null;
  };
  type VersionHit = {
    article_id: string;
    slug: string;
    title: string;
    archived_at: Date | null;
    content_text: string | null;
    markdown_source: string | null;
  };

  const COMPANY = '00000000-0000-0000-0000-0000000000c1';
  const LIVE_ARTICLE = '11111111-1111-1111-1111-111111111111';
  const ARCHIVED_ARTICLE = '22222222-2222-2222-2222-222222222222';
  const VERSION_ARTICLE = '33333333-3333-3333-3333-333333333333';

  const UPLOAD_LIVE = '44444444-4444-4444-4444-444444444444';
  const UPLOAD_VERSIONED = '55555555-5555-5555-5555-555555555555';
  const UPLOAD_ARCHIVED = '66666666-6666-6666-6666-666666666666';
  const UPLOAD_ORPHAN = '77777777-7777-7777-7777-777777777777';
  const UPLOAD_LIVE_AND_VERSION = '88888888-8888-8888-8888-888888888888';

  function makeService(opts: {
    liveRows: LiveHit[];
    versionRows: VersionHit[];
  }): { service: UploadsService; queryRaw: jest.Mock } {
    let call = 0;
    const queryRaw = jest.fn().mockImplementation(() => {
      call += 1;
      // Promise.all dispatches in order: first call = live scan,
      // second call = version scan.
      return call === 1 ? Promise.resolve(opts.liveRows) : Promise.resolve(opts.versionRows);
    });
    const prisma = { $queryRaw: queryRaw };
    const service = new UploadsService(
      prisma as never,
      {} as never,
      { client: {} } as never,
      { log: jest.fn() } as never,
      { values: { MAX_UPLOAD_MB: 1, ALLOWED_UPLOAD_MIME: '' } } as never,
    );
    return { service, queryRaw };
  }

  // Match the URL shape the rich-text editor actually writes (see
  // `extractEmbeddedUploadIds`):
  //   /api/v1/companies/<companyId>/uploads/<uploadId>/(image|blob)
  const url = (uploadId: string) =>
    `/api/v1/companies/${COMPANY}/uploads/${uploadId}/image`;

  it('classifies live, versioned, archived, and orphan in one pass', async () => {
    const { service } = makeService({
      liveRows: [
        {
          id: LIVE_ARTICLE,
          slug: 'live-one',
          title: 'Live One',
          archived_at: null,
          content_text: `<img src="${url(UPLOAD_LIVE)}" />`,
          markdown_source: null,
        },
        {
          id: ARCHIVED_ARTICLE,
          slug: 'archived-one',
          title: 'Archived One',
          archived_at: new Date('2026-01-01T00:00:00Z'),
          content_text: `body <img src="${url(UPLOAD_ARCHIVED)}" />`,
          markdown_source: null,
        },
      ],
      versionRows: [
        {
          article_id: VERSION_ARTICLE,
          slug: 'version-one',
          title: 'Version One',
          archived_at: null,
          content_text: null,
          markdown_source: `![](${url(UPLOAD_VERSIONED)})`,
        },
      ],
    });

    const result = await service.classifyArticleUploads(COMPANY, [
      UPLOAD_LIVE,
      UPLOAD_VERSIONED,
      UPLOAD_ARCHIVED,
      UPLOAD_ORPHAN,
    ]);

    expect(result.get(UPLOAD_LIVE)).toEqual({
      state: 'live',
      sourceArticle: { id: LIVE_ARTICLE, slug: 'live-one', title: 'Live One' },
    });
    expect(result.get(UPLOAD_VERSIONED)).toEqual({
      state: 'versioned',
      sourceArticle: {
        id: VERSION_ARTICLE,
        slug: 'version-one',
        title: 'Version One',
      },
    });
    expect(result.get(UPLOAD_ARCHIVED)).toEqual({
      state: 'archived',
      sourceArticle: {
        id: ARCHIVED_ARTICLE,
        slug: 'archived-one',
        title: 'Archived One',
      },
    });
    expect(result.get(UPLOAD_ORPHAN)).toEqual({
      state: 'orphan',
      sourceArticle: null,
    });
  });

  it('prefers live over versioned when the same upload appears in both', async () => {
    const { service } = makeService({
      liveRows: [
        {
          id: LIVE_ARTICLE,
          slug: 'live-one',
          title: 'Live One',
          archived_at: null,
          content_text: `<img src="${url(UPLOAD_LIVE_AND_VERSION)}" />`,
          markdown_source: null,
        },
      ],
      versionRows: [
        {
          article_id: VERSION_ARTICLE,
          slug: 'version-one',
          title: 'Version One',
          archived_at: null,
          content_text: `<img src="${url(UPLOAD_LIVE_AND_VERSION)}" />`,
          markdown_source: null,
        },
      ],
    });

    const result = await service.classifyArticleUploads(COMPANY, [
      UPLOAD_LIVE_AND_VERSION,
    ]);
    expect(result.get(UPLOAD_LIVE_AND_VERSION)?.state).toBe('live');
  });

  it('prefers versioned (active) over archived when both reference the upload', async () => {
    const { service } = makeService({
      liveRows: [
        {
          id: ARCHIVED_ARTICLE,
          slug: 'archived-one',
          title: 'Archived One',
          archived_at: new Date('2026-01-01T00:00:00Z'),
          content_text: `<img src="${url(UPLOAD_LIVE_AND_VERSION)}" />`,
          markdown_source: null,
        },
      ],
      versionRows: [
        {
          article_id: VERSION_ARTICLE,
          slug: 'version-one',
          title: 'Version One',
          archived_at: null,
          content_text: `<img src="${url(UPLOAD_LIVE_AND_VERSION)}" />`,
          markdown_source: null,
        },
      ],
    });

    const result = await service.classifyArticleUploads(COMPANY, [
      UPLOAD_LIVE_AND_VERSION,
    ]);
    expect(result.get(UPLOAD_LIVE_AND_VERSION)?.state).toBe('versioned');
  });

  it('marks every requested id as orphan when none survives the UUID filter', async () => {
    const { service, queryRaw } = makeService({
      liveRows: [],
      versionRows: [],
    });

    const result = await service.classifyArticleUploads(COMPANY, [
      'not-a-uuid',
    ]);
    expect(result.get('not-a-uuid')).toEqual({
      state: 'orphan',
      sourceArticle: null,
    });
    // No SQL runs when we have no UUIDs to scan against.
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('UploadsService.softDeleteFromPhotos (state gate)', () => {
  type Upload = {
    id: string;
    companyId: string;
    attachedToType: string | null;
    attachedToId: string | null;
    deletedAt: Date | null;
    [k: string]: unknown;
  };

  function makeService(opts: {
    upload: Upload | null;
    classify: () => Promise<{
      state: 'live' | 'versioned' | 'archived' | 'orphan';
      sourceArticle: { id: string; slug: string; title: string } | null;
    } | null>;
  }): {
    service: UploadsService;
    audit: { log: jest.Mock };
    updateMany: jest.Mock;
  } {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findFirst = jest.fn().mockResolvedValue(opts.upload);
    const findFirstOrThrow = jest
      .fn()
      .mockResolvedValue({ ...opts.upload, deletedAt: new Date() });
    const prisma = {
      upload: {
        findFirst,
        findFirstOrThrow,
        updateMany,
      },
    };
    const audit = { log: jest.fn() };
    const service = new UploadsService(
      prisma as never,
      {} as never,
      { client: {} } as never,
      audit as never,
      { values: { MAX_UPLOAD_MB: 1, ALLOWED_UPLOAD_MIME: '' } } as never,
    );
    (
      service as unknown as { classifyArticleUpload: typeof opts.classify }
    ).classifyArticleUpload = opts.classify;
    return { service, audit, updateMany };
  }

  const actor = { id: 'user-1' } as never;
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  it('rejects a live article image', async () => {
    const { service, updateMany } = makeService({
      upload: {
        id: 'u-live',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: null,
        deletedAt: null,
      },
      classify: async () => ({ state: 'live', sourceArticle: null }),
    });
    await expect(
      service.softDeleteFromPhotos(actor, 'c1', 'u-live', meta),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rejects a versioned article image', async () => {
    const { service, updateMany } = makeService({
      upload: {
        id: 'u-ver',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: null,
        deletedAt: null,
      },
      classify: async () => ({ state: 'versioned', sourceArticle: null }),
    });
    await expect(
      service.softDeleteFromPhotos(actor, 'c1', 'u-ver', meta),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('allows deletion of an orphan article image and records state in audit', async () => {
    const { service, audit, updateMany } = makeService({
      upload: {
        id: 'u-orph',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: null,
        deletedAt: null,
      },
      classify: async () => ({ state: 'orphan', sourceArticle: null }),
    });
    await service.softDeleteFromPhotos(actor, 'c1', 'u-orph', meta);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'upload.delete',
        before: expect.objectContaining({
          articleLinkState: 'orphan',
          via: 'photos',
        }),
      }),
    );
  });

  it('allows deletion of an archived article image', async () => {
    const { service, updateMany } = makeService({
      upload: {
        id: 'u-arc',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: null,
        deletedAt: null,
      },
      classify: async () => ({ state: 'archived', sourceArticle: null }),
    });
    await service.softDeleteFromPhotos(actor, 'c1', 'u-arc', meta);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('skips the gate for non-article uploads (assets, asset-fields, attachments)', async () => {
    const classify = jest.fn();
    const { service, updateMany } = makeService({
      upload: {
        id: 'u-asset',
        companyId: 'c1',
        attachedToType: 'asset',
        attachedToId: 'a-1',
        deletedAt: null,
      },
      classify,
    });
    await service.softDeleteFromPhotos(actor, 'c1', 'u-asset', meta);
    expect(classify).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});

/**
 * Parent-visibility gate for CLIENT_USER on every upload read path.
 * The full ruleset lives in `assertReadable`; these specs cover one
 * branch per parent type via the public `openImageStream` entry point
 * so the controller wiring is exercised too. The matching list-side
 * filter is exercised below in `paginatedList`.
 */
describe('UploadsService.assertReadable (CLIENT_USER gate)', () => {
  function makeService(opts: {
    upload: {
      id: string;
      companyId: string;
      attachedToType: string | null;
      attachedToId: string | null;
      [k: string]: unknown;
    } | null;
    article?: { id: string } | null;
    password?: {
      id: string;
      visibleToClients: boolean;
      restrictedToUserIds: string[];
    } | null;
    assetField?: { id: string } | null;
    classify?: () => Promise<
      Map<
        string,
        { state: 'live' | 'versioned' | 'archived' | 'orphan'; sourceArticle: unknown }
      >
    >;
  }) {
    const upload = opts.upload;
    const storageStream = {
      body: (async function* () {})(),
      contentType: 'image/png',
      contentLength: 0,
    };
    const prisma = {
      upload: {
        findFirst: jest.fn().mockResolvedValue(upload),
      },
      article: {
        findFirst: jest.fn().mockResolvedValue(opts.article ?? null),
      },
      password: {
        findFirst: jest.fn().mockResolvedValue(opts.password ?? null),
      },
      assetField: {
        findFirst: jest.fn().mockResolvedValue(opts.assetField ?? null),
      },
    };
    const storage = {
      getObjectStream: jest.fn().mockResolvedValue(storageStream),
    };
    const service = new UploadsService(
      prisma as never,
      storage as never,
      { client: {} } as never,
      { log: jest.fn() } as never,
      { values: { MAX_UPLOAD_MB: 1, ALLOWED_UPLOAD_MIME: '' } } as never,
    );
    if (opts.classify) {
      (
        service as unknown as { classifyArticleUploads: typeof opts.classify }
      ).classifyArticleUploads = opts.classify;
    }
    return { service, prisma, storage };
  }

  const clientActor = { id: 'u1', role: 'CLIENT_USER' } as never;
  const operatorActor = { id: 'u1', role: 'OPERATOR' } as never;
  const otherOperatorActor = { id: 'u2', role: 'OPERATOR' } as never;

  it('allows OPERATOR to stream an upload attached to an invisible article', async () => {
    const { service, storage } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: 'art-hidden',
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      article: null, // hidden / archived
    });
    const result = await service.openImageStream(
      'c1',
      'u1',
      'original',
      operatorActor,
    );
    expect(result).not.toBeNull();
    expect(storage.getObjectStream).toHaveBeenCalled();
  });

  it('denies CLIENT_USER on an upload attached to a hidden article', async () => {
    const { service, storage } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: 'art-hidden',
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      article: null,
    });
    await expect(
      service.openImageStream('c1', 'u1', 'original', clientActor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('allows CLIENT_USER on an upload attached to a visible non-archived article', async () => {
    const { service } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: 'art-visible',
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      article: { id: 'art-visible' },
    });
    const result = await service.openImageStream(
      'c1',
      'u1',
      'original',
      clientActor,
    );
    expect(result).not.toBeNull();
  });

  it("allows CLIENT_USER on a body-embedded image when classifier reports 'live'", async () => {
    const { service } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: null,
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      classify: async () =>
        new Map([['u1', { state: 'live', sourceArticle: null }]]),
    });
    const result = await service.openImageStream(
      'c1',
      'u1',
      'original',
      clientActor,
    );
    expect(result).not.toBeNull();
  });

  it("denies CLIENT_USER on a body-embedded image when classifier reports 'archived'", async () => {
    const { service } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: null,
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      classify: async () =>
        new Map([['u1', { state: 'archived', sourceArticle: null }]]),
    });
    await expect(
      service.openImageStream('c1', 'u1', 'original', clientActor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("denies CLIENT_USER on a body-embedded image when classifier reports 'orphan'", async () => {
    const { service } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'article',
        attachedToId: null,
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      classify: async () =>
        new Map([['u1', { state: 'orphan', sourceArticle: null }]]),
    });
    await expect(
      service.openImageStream('c1', 'u1', 'original', clientActor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('denies CLIENT_USER on an upload attached to a hidden password', async () => {
    const { service } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'password',
        attachedToId: 'pw-hidden',
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      password: null,
    });
    await expect(
      service.openImageStream('c1', 'u1', 'original', clientActor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows CLIENT_USER on an upload attached to a visible password', async () => {
    const { service } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'password',
        attachedToId: 'pw-ok',
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      password: { id: 'pw-ok', visibleToClients: true, restrictedToUserIds: [] },
    });
    const result = await service.openImageStream(
      'c1',
      'u1',
      'original',
      clientActor,
    );
    expect(result).not.toBeNull();
  });

  it('denies OPERATOR on an upload attached to a credential restricted to someone else', async () => {
    const { service, storage } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'password',
        attachedToId: 'pw-restricted',
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      password: {
        id: 'pw-restricted',
        visibleToClients: true,
        restrictedToUserIds: ['u1'],
      },
    });
    await expect(
      service.openImageStream('c1', 'u1', 'original', otherOperatorActor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('denies CLIENT_USER on an upload attached to a hidden asset field', async () => {
    const { service } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'asset_field',
        attachedToId: 'fld-hidden',
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
      assetField: null,
    });
    await expect(
      service.openImageStream('c1', 'u1', 'original', clientActor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('allows CLIENT_USER on an upload attached to a general asset (no flag)', async () => {
    const { service, prisma } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: 'asset',
        attachedToId: 'asset-1',
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
    });
    const result = await service.openImageStream(
      'c1',
      'u1',
      'original',
      clientActor,
    );
    expect(result).not.toBeNull();
    expect(prisma.article.findFirst).not.toHaveBeenCalled();
    expect(prisma.password.findFirst).not.toHaveBeenCalled();
    expect(prisma.assetField.findFirst).not.toHaveBeenCalled();
  });

  it('denies CLIENT_USER on an orphan upload with null attachedToType', async () => {
    const { service } = makeService({
      upload: {
        id: 'u1',
        companyId: 'c1',
        attachedToType: null,
        attachedToId: null,
        storageKey: 'k',
        thumbnailKey: null,
        mimeType: 'image/png',
        filename: 'a.png',
      },
    });
    await expect(
      service.openImageStream('c1', 'u1', 'original', clientActor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * WS-013: upload confirmation and attachment-parent invariants.
 *   - `confirm` repeats the uploader-ownership check `relayPut` enforces,
 *     so a confirm with a known UUID can't be driven by another user.
 *   - `init` and `confirm` both reject an attachment whose parent is
 *     missing or belongs to a different company, and apply the
 *     password read policy (`canReadPassword`) to password attachments.
 */
describe('UploadsService attachment parent invariants (WS-013)', () => {
  type Parents = {
    asset?: { id: string } | null;
    article?: { id: string } | null;
    assetField?: { id: string } | null;
    password?: {
      id: string;
      visibleToClients: boolean;
      restrictedToUserIds: string[];
    } | null;
  };

  function makeService(parents: Parents = {}) {
    const prisma = {
      upload: { create: jest.fn() },
      asset: { findFirst: jest.fn().mockResolvedValue(parents.asset ?? null) },
      article: {
        findFirst: jest.fn().mockResolvedValue(parents.article ?? null),
      },
      assetField: {
        findFirst: jest.fn().mockResolvedValue(parents.assetField ?? null),
      },
      password: {
        findFirst: jest.fn().mockResolvedValue(parents.password ?? null),
      },
    };
    const storage = {
      ensureBucket: jest.fn().mockResolvedValue('/files/c1'),
      uploadKey: jest
        .fn()
        .mockImplementation(
          (cid: string, uid: string, name: string) =>
            `${cid}/uploads/${uid}/${name}`,
        ),
      headObject: jest.fn(),
      deleteObject: jest.fn(),
      putObject: jest.fn(),
      thumbnailKey: jest.fn(),
    };
    const redis = {
      client: {
        get: jest.fn(),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn(),
      },
    };
    const service = new UploadsService(
      prisma as never,
      storage as never,
      redis as never,
      { log: jest.fn() } as never,
      {
        values: {
          MAX_UPLOAD_MB: 25,
          ALLOWED_UPLOAD_MIME: 'image/png,application/zip',
        },
      } as never,
    );
    return { service, prisma, storage, redis };
  }

  const operator = { id: 'user-1', role: 'OPERATOR' } as never;
  const baseInit = { filename: 'a.png', mimeType: 'image/png', sizeBytes: 100 };
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  describe('init parent validation', () => {
    it('allows an upload with no attachment target', async () => {
      const { service, redis } = makeService();
      const res = await service.init(operator, 'c1', { ...baseInit } as never);
      expect(res.relayUrl).toContain('/uploads/');
      expect(redis.client.set).toHaveBeenCalled();
    });

    it('allows an article attachment with no id (parent may not exist yet)', async () => {
      const { service, prisma, redis } = makeService();
      await service.init(operator, 'c1', {
        ...baseInit,
        attachedToType: 'article',
      } as never);
      expect(prisma.article.findFirst).not.toHaveBeenCalled();
      expect(redis.client.set).toHaveBeenCalled();
    });

    it('accepts an asset attachment that exists in the company', async () => {
      const { service, redis } = makeService({ asset: { id: 'asset-1' } });
      await service.init(operator, 'c1', {
        ...baseInit,
        attachedToType: 'asset',
        attachedToId: 'asset-1',
      } as never);
      expect(redis.client.set).toHaveBeenCalled();
    });

    it('rejects an asset attachment that is missing or cross-company', async () => {
      const { service, storage, redis } = makeService({ asset: null });
      await expect(
        service.init(operator, 'c1', {
          ...baseInit,
          attachedToType: 'asset',
          attachedToId: 'asset-x',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Rejected before any storage / pending-session side effects.
      expect(storage.ensureBucket).not.toHaveBeenCalled();
      expect(redis.client.set).not.toHaveBeenCalled();
    });

    it('rejects an article attachment that is missing or cross-company', async () => {
      const { service, redis } = makeService({ article: null });
      await expect(
        service.init(operator, 'c1', {
          ...baseInit,
          attachedToType: 'article',
          attachedToId: 'art-x',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(redis.client.set).not.toHaveBeenCalled();
    });

    it('rejects an asset_field attachment whose field does not exist', async () => {
      const { service, redis } = makeService({ assetField: null });
      await expect(
        service.init(operator, 'c1', {
          ...baseInit,
          attachedToType: 'asset_field',
          attachedToId: 'fld-x',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(redis.client.set).not.toHaveBeenCalled();
    });

    it('accepts an asset_field attachment whose field exists', async () => {
      const { service, redis } = makeService({ assetField: { id: 'fld-1' } });
      await service.init(operator, 'c1', {
        ...baseInit,
        attachedToType: 'asset_field',
        attachedToId: 'fld-1',
      } as never);
      expect(redis.client.set).toHaveBeenCalled();
    });

    it('rejects a password attachment that is missing or cross-company', async () => {
      const { service, redis } = makeService({ password: null });
      await expect(
        service.init(operator, 'c1', {
          ...baseInit,
          attachedToType: 'password',
          attachedToId: 'pw-x',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(redis.client.set).not.toHaveBeenCalled();
    });

    it('rejects a password attachment the actor cannot read (restricted to others)', async () => {
      const { service, redis } = makeService({
        password: {
          id: 'pw-restricted',
          visibleToClients: true,
          restrictedToUserIds: ['someone-else'],
        },
      });
      await expect(
        service.init(operator, 'c1', {
          ...baseInit,
          attachedToType: 'password',
          attachedToId: 'pw-restricted',
        } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(redis.client.set).not.toHaveBeenCalled();
    });

    it('accepts a password attachment the actor can read', async () => {
      const { service, redis } = makeService({
        password: {
          id: 'pw-ok',
          visibleToClients: true,
          restrictedToUserIds: [],
        },
      });
      await service.init(operator, 'c1', {
        ...baseInit,
        attachedToType: 'password',
        attachedToId: 'pw-ok',
      } as never);
      expect(redis.client.set).toHaveBeenCalled();
    });
  });

  describe('confirm ownership + parent validation', () => {
    function pendingJson(over: Record<string, unknown> = {}) {
      return JSON.stringify({
        companyId: 'c1',
        filename: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 5,
        storageKey: 'c1/uploads/u-1/a.png',
        uploaderId: 'user-1',
        attachedToType: null,
        attachedToId: null,
        ...over,
      });
    }

    it('rejects a confirm driven by a different user than the uploader', async () => {
      const { service, storage, redis } = makeService();
      redis.client.get.mockResolvedValue(
        pendingJson({ uploaderId: 'someone-else' }),
      );
      await expect(
        service.confirm(operator, 'c1', { uploadId: 'u-1' } as never, meta),
      ).rejects.toBeInstanceOf(ForbiddenException);
      // Short-circuits before any storage / body work.
      expect(storage.headObject).not.toHaveBeenCalled();
    });

    it('fails closed when the pending session has no uploaderId', async () => {
      const { service, storage, redis } = makeService();
      redis.client.get.mockResolvedValue(pendingJson({ uploaderId: null }));
      await expect(
        service.confirm(operator, 'c1', { uploadId: 'u-1' } as never, meta),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(storage.headObject).not.toHaveBeenCalled();
    });

    it('rejects a confirm whose attachment target is missing or cross-company', async () => {
      const { service, storage, redis } = makeService({ password: null });
      redis.client.get.mockResolvedValue(
        pendingJson({ attachedToType: 'password', attachedToId: 'pw-x' }),
      );
      await expect(
        service.confirm(operator, 'c1', { uploadId: 'u-1' } as never, meta),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.headObject).not.toHaveBeenCalled();
    });

    it('validates an attachment target supplied at confirm time (overriding init)', async () => {
      const { service, storage, redis, prisma } = makeService({ asset: null });
      // The pending session carried no attachment; confirm attempts to
      // attach to a missing asset — the override is still validated.
      redis.client.get.mockResolvedValue(pendingJson());
      await expect(
        service.confirm(
          operator,
          'c1',
          {
            uploadId: 'u-1',
            attachedToType: 'asset',
            attachedToId: 'asset-x',
          } as never,
          meta,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.asset.findFirst).toHaveBeenCalled();
      expect(storage.headObject).not.toHaveBeenCalled();
    });
  });
});

describe('UploadsService.paginatedList CLIENT_USER filter', () => {
  function build(rows: Array<Partial<Upload> & { id: string }>) {
    const uploads = rows.map((r) => baseUpload(r));
    const findMany = jest
      .fn()
      .mockImplementation(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        return uploads.filter((u) => {
          if (w.companyId && u.companyId !== w.companyId) return false;
          if (w.deletedAt === null && u.deletedAt !== null) return false;
          if (w.onlyImages || w.isImage === true) {
            if (!u.isImage) return false;
          }
          return true;
        });
      });
    const articleFindMany = jest.fn().mockResolvedValue([{ id: 'art-ok' }]);
    const passwordFindMany = jest.fn().mockImplementation(async (args: { where: { id?: { in?: string[] } } }) => {
      const ids = new Set(args.where.id?.in ?? []);
      return [
        { id: 'pw-ok', visibleToClients: true, restrictedToUserIds: [] },
        { id: 'pw-hidden', visibleToClients: false, restrictedToUserIds: [] },
        // Internal credential restricted to a specific operator ('other-op').
        // Governs the allow-list enforcement on the list/photos path.
        {
          id: 'pw-restricted',
          visibleToClients: false,
          restrictedToUserIds: ['other-op'],
        },
      ].filter((row) => ids.has(row.id));
    });
    const assetFieldFindMany = jest.fn().mockResolvedValue([{ id: 'fld-ok' }]);
    const prisma = {
      upload: { findMany },
      article: { findMany: articleFindMany },
      password: { findMany: passwordFindMany },
      assetField: { findMany: assetFieldFindMany },
    };
    const service = new UploadsService(
      prisma as never,
      {} as never,
      { client: {} } as never,
      { log: jest.fn() } as never,
      { values: { MAX_UPLOAD_MB: 1, ALLOWED_UPLOAD_MIME: '' } } as never,
    );
    (
      service as unknown as {
        classifyArticleUploads: (
          c: string,
          ids: string[],
        ) => Promise<
          Map<string, { state: string; sourceArticle: unknown }>
        >;
      }
    ).classifyArticleUploads = async (_c, ids) =>
      new Map(
        ids.map((id) => [
          id,
          {
            state: id === 'u-live-body' ? 'live' : 'archived',
            sourceArticle: null,
          },
        ]),
      );
    return { service };
  }

  it('drops uploads attached to hidden parents for CLIENT_USER', async () => {
    const { service } = build([
      { id: 'u-asset', isImage: true, attachedToType: 'asset', attachedToId: 'a' },
      {
        id: 'u-art-ok',
        isImage: true,
        attachedToType: 'article',
        attachedToId: 'art-ok',
      },
      {
        id: 'u-art-hidden',
        isImage: true,
        attachedToType: 'article',
        attachedToId: 'art-hidden',
      },
      {
        id: 'u-pw-ok',
        isImage: true,
        attachedToType: 'password',
        attachedToId: 'pw-ok',
      },
      {
        id: 'u-pw-hidden',
        isImage: true,
        attachedToType: 'password',
        attachedToId: 'pw-hidden',
      },
      {
        id: 'u-fld-ok',
        isImage: true,
        attachedToType: 'asset_field',
        attachedToId: 'fld-ok',
      },
      {
        id: 'u-fld-hidden',
        isImage: true,
        attachedToType: 'asset_field',
        attachedToId: 'fld-hidden',
      },
      {
        id: 'u-orphan',
        isImage: true,
        attachedToType: null,
        attachedToId: null,
      },
      {
        id: 'u-live-body',
        isImage: true,
        attachedToType: 'article',
        attachedToId: null,
      },
      {
        id: 'u-archived-body',
        isImage: true,
        attachedToType: 'article',
        attachedToId: null,
      },
    ]);

    const res = await service.listPhotos('c1', {
      actor: { id: 'cu', role: 'CLIENT_USER' } as never,
      limit: 50,
    });
    const ids = res.items.map((i) => i.id).sort();
    expect(ids).toEqual(['u-art-ok', 'u-asset', 'u-fld-ok', 'u-live-body', 'u-pw-ok']);
  });

  it('skips article/asset-field/orphan visibility rules for internal actors but still enforces the password allow-list', async () => {
    const { service } = build([
      { id: 'u-asset', isImage: true, attachedToType: 'asset', attachedToId: 'a' },
      {
        // Client-hidden but NOT restricted → readable by any operator.
        id: 'u-pw-open',
        isImage: true,
        attachedToType: 'password',
        attachedToId: 'pw-hidden',
      },
      {
        // Restricted to 'other-op' → the acting operator 'op' is not on it.
        id: 'u-pw-restricted',
        isImage: true,
        attachedToType: 'password',
        attachedToId: 'pw-restricted',
      },
      {
        id: 'u-orphan',
        isImage: true,
        attachedToType: null,
        attachedToId: null,
      },
    ]);
    const res = await service.listPhotos('c1', {
      actor: { id: 'op', role: 'OPERATOR' } as never,
      limit: 50,
      includeNonLatest: true,
    });
    // Asset + unrestricted (client-hidden) password + orphan pass through;
    // the credential restricted to someone else is filtered out even for
    // an internal actor.
    expect(res.items.map((i) => i.id).sort()).toEqual([
      'u-asset',
      'u-orphan',
      'u-pw-open',
    ]);
  });

  it('keeps restricted password attachments for allow-listed and super-admin actors', async () => {
    const { service } = build([
      {
        id: 'u-pw-restricted',
        isImage: true,
        attachedToType: 'password',
        attachedToId: 'pw-restricted',
      },
    ]);

    // Operator on the allow-list ('other-op') sees the attachment.
    const allowListed = await service.listPhotos('c1', {
      actor: { id: 'other-op', role: 'OPERATOR' } as never,
      limit: 50,
      includeNonLatest: true,
    });
    expect(allowListed.items.map((i) => i.id)).toEqual(['u-pw-restricted']);

    // SUPER_ADMIN bypasses the allow-list entirely.
    const superAdmin = await service.listPhotos('c1', {
      actor: { id: 'root', role: 'SUPER_ADMIN' } as never,
      limit: 50,
      includeNonLatest: true,
    });
    expect(superAdmin.items.map((i) => i.id)).toEqual(['u-pw-restricted']);
  });
});

describe('UploadsService.confirm — streamed hashing + storage-read races', () => {
  const operator = { id: 'user-1', role: 'OPERATOR' } as never;
  const auditMeta = { ip: '127.0.0.1', userAgent: 'jest' };

  // These cases deliberately drive the text/* + UTF-8 BOM fast-path,
  // which skips `file-type`, so they isolate the streamed SHA-256 and the
  // null-storage-read guards. Real magic-byte detection and the image
  // thumbnail path are covered in the sibling describe block below.
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);

  function makeService(opts: {
    head: Buffer | null;
    body: Buffer;
    streamNull?: boolean;
  }) {
    const prisma = {
      upload: {
        create: jest
          .fn()
          .mockImplementation(
            async ({ data }: { data: Record<string, unknown> }) => ({
              ...data,
              createdAt: new Date('2026-01-01T00:00:00Z'),
            }),
          ),
      },
      asset: { findFirst: jest.fn().mockResolvedValue(null) },
      article: { findFirst: jest.fn().mockResolvedValue(null) },
      assetField: { findFirst: jest.fn().mockResolvedValue(null) },
      password: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = {
      headObject: jest.fn().mockResolvedValue({
        ContentLength: opts.body.length,
        LastModified: new Date('2026-01-01T00:00:00Z'),
        ETag: '"e"',
      }),
      getObjectHead: jest.fn().mockResolvedValue(opts.head),
      getObjectStream: jest
        .fn()
        .mockResolvedValue(
          opts.streamNull ? null : { body: Readable.from(opts.body) },
        ),
      getObjectPath: jest.fn().mockReturnValue('/unused'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      putObject: jest.fn().mockResolvedValue(undefined),
      thumbnailKey: jest.fn().mockReturnValue('c1/thumbs/u-1.webp'),
    };
    const redis = {
      client: {
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            companyId: 'c1',
            filename: 'note.txt',
            mimeType: 'text/plain',
            sizeBytes: opts.body.length,
            storageKey: 'c1/uploads/u-1/note.txt',
            uploaderId: 'user-1',
            attachedToType: null,
            attachedToId: null,
          }),
        ),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new UploadsService(
      prisma as never,
      storage as never,
      redis as never,
      { log: jest.fn() } as never,
      {
        values: { MAX_UPLOAD_MB: 25, ALLOWED_UPLOAD_MIME: 'text/plain' },
      } as never,
    );
    return { service, prisma, storage };
  }

  it('hashes the stored file by streaming and persists the digest', async () => {
    const body = Buffer.concat([bom, Buffer.from('hello world')]);
    const expected = createHash('sha256').update(body).digest('hex');
    const { service, prisma, storage } = makeService({ head: body, body });
    const res = await service.confirm(
      operator,
      'c1',
      { uploadId: 'u-1' } as never,
      auditMeta,
    );
    // Hash comes from a streamed read, not a full in-memory buffer.
    expect(storage.getObjectStream).toHaveBeenCalledWith(
      'c1',
      'c1/uploads/u-1/note.txt',
    );
    expect(res.sha256).toBe(expected);
    expect(prisma.upload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sha256: expected, isImage: false }),
      }),
    );
  });

  it('returns a shaped 400 (not a 500) when the head read races to null', async () => {
    const { service } = makeService({ head: null, body: Buffer.from('x') });
    await expect(
      service.confirm(operator, 'c1', { uploadId: 'u-1' } as never, auditMeta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a shaped 400 (not a 500) when the hash stream races to null', async () => {
    const body = Buffer.concat([bom, Buffer.from('hi')]);
    const { service } = makeService({ head: body, body, streamNull: true });
    await expect(
      service.confirm(operator, 'c1', { uploadId: 'u-1' } as never, auditMeta),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('UploadsService.confirm — magic-byte validation + image thumbnail (real file-type/sharp)', () => {
  const operator = { id: 'user-1', role: 'OPERATOR' } as never;
  const auditMeta = { ip: '127.0.0.1', userAgent: 'jest' };
  const docxMime =
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const allowed = `image/png,application/zip,${docxMime}`;
  // A real single-entry ZIP (contains `hello.txt`); `file-type` reports it
  // as application/zip — the declared-docx compatibility case.
  const realZip = Buffer.from(
    'UEsDBAoAAAAAAFY/4VyGphA2BQAAAAUAAAAJABwAaGVsbG8udHh0VVQJAAPzAEVq8wBFanV4CwABBPUBAAAEFAAAAGhlbGxvUEsBAh4DCgAAAAAAVj/hXIamEDYFAAAABQAAAAkAGAAAAAAAAQAAAKSBAAAAAGhlbGxvLnR4dFVUBQAD8wBFanV4CwABBPUBAAAEFAAAAFBLBQYAAAAAAQABAE8AAABIAAAAAAA=',
    'base64',
  );

  let pngBuffer: Buffer;
  let tmpDir: string;
  let pngPath: string;

  beforeAll(async () => {
    pngBuffer = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    tmpDir = await fs.mkdtemp(join(tmpdir(), 'confirm-real-'));
    pngPath = join(tmpDir, 'img.png');
    await fs.writeFile(pngPath, pngBuffer);
  });

  afterAll(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeService(opts: {
    mimeType: string;
    head: Buffer;
    body: Buffer;
    objectPath?: string;
  }) {
    const prisma = {
      upload: {
        create: jest
          .fn()
          .mockImplementation(
            async ({ data }: { data: Record<string, unknown> }) => ({
              ...data,
              createdAt: new Date('2026-01-01T00:00:00Z'),
            }),
          ),
      },
      asset: { findFirst: jest.fn().mockResolvedValue(null) },
      article: { findFirst: jest.fn().mockResolvedValue(null) },
      assetField: { findFirst: jest.fn().mockResolvedValue(null) },
      password: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = {
      headObject: jest.fn().mockResolvedValue({
        ContentLength: opts.body.length,
        LastModified: new Date('2026-01-01T00:00:00Z'),
        ETag: '"e"',
      }),
      getObjectHead: jest.fn().mockResolvedValue(opts.head),
      getObjectStream: jest
        .fn()
        .mockResolvedValue({ body: Readable.from(opts.body) }),
      getObjectPath: jest.fn().mockReturnValue(opts.objectPath ?? '/unused'),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      putObject: jest.fn().mockResolvedValue(undefined),
      thumbnailKey: jest.fn().mockReturnValue('c1/thumbs/u-1.webp'),
    };
    const redis = {
      client: {
        get: jest.fn().mockResolvedValue(
          JSON.stringify({
            companyId: 'c1',
            filename: 'f',
            mimeType: opts.mimeType,
            sizeBytes: opts.body.length,
            storageKey: 'c1/uploads/u-1/f',
            uploaderId: 'user-1',
            attachedToType: null,
            attachedToId: null,
          }),
        ),
        set: jest.fn().mockResolvedValue('OK'),
        del: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new UploadsService(
      prisma as never,
      storage as never,
      redis as never,
      { log: jest.fn() } as never,
      { values: { MAX_UPLOAD_MB: 25, ALLOWED_UPLOAD_MIME: allowed } } as never,
    );
    return { service, prisma, storage };
  }

  it('rejects when magic bytes contradict the declared MIME and deletes the object', async () => {
    // Declared a zip, but the stored bytes are a real PNG → mismatch.
    const { service, storage } = makeService({
      mimeType: 'application/zip',
      head: pngBuffer,
      body: pngBuffer,
    });
    await expect(
      service.confirm(operator, 'c1', { uploadId: 'u-1' } as never, auditMeta),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.deleteObject).toHaveBeenCalled();
    // Rejected before spending work hashing the body.
    expect(storage.getObjectStream).not.toHaveBeenCalled();
  });

  it('accepts a docx whose magic bytes detect as zip (compatible) and keeps the declared MIME', async () => {
    const { service, prisma } = makeService({
      mimeType: docxMime,
      head: realZip,
      body: realZip,
    });
    await service.confirm(
      operator,
      'c1',
      { uploadId: 'u-1' } as never,
      auditMeta,
    );
    expect(prisma.upload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mimeType: docxMime, isImage: false }),
      }),
    );
  });

  it('records dimensions and writes a thumbnail for an image (sharp reads the stored path)', async () => {
    const { service, prisma, storage } = makeService({
      mimeType: 'image/png',
      head: pngBuffer,
      body: pngBuffer,
      objectPath: pngPath,
    });
    await service.confirm(
      operator,
      'c1',
      { uploadId: 'u-1' } as never,
      auditMeta,
    );
    expect(storage.getObjectPath).toHaveBeenCalledWith(
      'c1',
      'c1/uploads/u-1/f',
    );
    expect(prisma.upload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isImage: true,
          width: 8,
          height: 8,
          thumbnailKey: 'c1/thumbs/u-1.webp',
        }),
      }),
    );
    expect(storage.putObject).toHaveBeenCalledWith(
      'c1',
      'c1/thumbs/u-1.webp',
      expect.any(Buffer),
      { contentType: 'image/webp' },
    );
  });
});

describe('UploadsService.restore / restoreInfo', () => {
  type Row = {
    id: string;
    companyId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    sha256: string;
    isImage: boolean;
    width: number | null;
    height: number | null;
    thumbnailKey: string | null;
    attachedToType: string | null;
    attachedToId: string | null;
    deletedAt: Date | null;
    uploaderId: string | null;
    createdAt: Date;
  };

  function row(over: Partial<Row> = {}): Row {
    return {
      id: 'u1',
      companyId: 'c1',
      filename: 'a.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      storageKey: 'c1/uploads/u1/a.png',
      sha256: 'abc',
      isImage: true,
      width: 10,
      height: 10,
      thumbnailKey: 'c1/thumbs/u1.webp',
      attachedToType: 'asset',
      attachedToId: 'a1',
      deletedAt: new Date('2026-06-01T00:00:00Z'),
      uploaderId: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      ...over,
    };
  }

  function makeService(opts: { upload: Row | null; updateCount?: number }) {
    const findFirst = jest.fn().mockResolvedValue(opts.upload);
    const updateMany = jest
      .fn()
      .mockResolvedValue({ count: opts.updateCount ?? 1 });
    const findFirstOrThrow = jest
      .fn()
      .mockResolvedValue(opts.upload ? { ...opts.upload, deletedAt: null } : null);
    // One mock per parent model so tests can both set the archive state and
    // assert that the switch routed to the correct model for the type.
    const parent = {
      asset: jest.fn().mockResolvedValue({ archivedAt: null }),
      article: jest.fn().mockResolvedValue({ archivedAt: null }),
      assetField: jest.fn().mockResolvedValue({ archivedAt: null }),
      password: jest.fn().mockResolvedValue({ archivedAt: null }),
    };
    const prisma = {
      upload: { findFirst, updateMany, findFirstOrThrow },
      asset: { findFirst: parent.asset },
      article: { findFirst: parent.article },
      assetField: { findFirst: parent.assetField },
      password: { findFirst: parent.password },
    };
    const audit = { log: jest.fn() };
    const service = new UploadsService(
      prisma as never,
      {} as never,
      { client: {} } as never,
      audit as never,
      { values: { MAX_UPLOAD_MB: 1, ALLOWED_UPLOAD_MIME: '' } } as never,
    );
    return { service, audit, findFirst, updateMany, findFirstOrThrow, parent };
  }

  const sa = { id: 'admin-1', role: 'SUPER_ADMIN' } as never;
  const operator = { id: 'user-1', role: 'OPERATOR' } as never;
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };

  // ---- restore ----

  it('rejects a non-SUPER_ADMIN actor before touching the row', async () => {
    const { service, updateMany, findFirst } = makeService({ upload: row() });
    await expect(
      service.restore(operator, 'c1', 'u1', meta),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findFirst).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('clears deletedAt (scoped to a still-deleted row) and audits upload.restore', async () => {
    const deletedAt = new Date('2026-06-01T00:00:00Z');
    const { service, audit, updateMany } = makeService({ upload: row({ deletedAt }) });
    const out = await service.restore(sa, 'c1', 'u1', meta);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'u1', companyId: 'c1', deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'upload.restore',
        entityType: 'Upload',
        entityId: 'u1',
        companyId: 'c1',
        before: { deletedAt },
        after: { deletedAt: null },
      }),
    );
    expect(out.id).toBe('u1');
  });

  it('is idempotent when the row is already live', async () => {
    const { service, audit, updateMany } = makeService({
      upload: row({ deletedAt: null }),
    });
    const out = await service.restore(sa, 'c1', 'u1', meta);
    expect(out.id).toBe('u1');
    expect(updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('throws NotFound when the row is already gone', async () => {
    const { service } = makeService({ upload: null });
    await expect(
      service.restore(sa, 'c1', 'u1', meta),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('blocks restore with 409 when the parent is missing', async () => {
    const { service, updateMany, parent } = makeService({ upload: row() });
    parent.asset.mockResolvedValueOnce(null);
    await expect(
      service.restore(sa, 'c1', 'u1', meta),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('blocks restore with 409 when the parent is archived (routes by type)', async () => {
    const { service, updateMany, parent } = makeService({
      upload: row({ attachedToType: 'password', attachedToId: 'p1' }),
    });
    parent.password.mockResolvedValueOnce({ archivedAt: new Date() });
    await expect(
      service.restore(sa, 'c1', 'u1', meta),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(parent.password).toHaveBeenCalledTimes(1);
    expect(parent.asset).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('restores an article upload with no attachedToId without a parent check', async () => {
    const { service, updateMany, parent } = makeService({
      upload: row({ attachedToType: 'article', attachedToId: null }),
    });
    await service.restore(sa, 'c1', 'u1', meta);
    expect(parent.article).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('resolves a concurrent reap (updateMany count 0, row vanished) as NotFound', async () => {
    const { service, findFirst } = makeService({ upload: row(), updateCount: 0 });
    // initial load → deleted row; post-update re-read → null (reaped)
    findFirst.mockReset();
    findFirst.mockResolvedValueOnce(row()).mockResolvedValueOnce(null);
    await expect(
      service.restore(sa, 'c1', 'u1', meta),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---- restoreInfo ----

  it('restoreInfo rejects a non-SUPER_ADMIN actor', async () => {
    const { service } = makeService({ upload: row() });
    await expect(
      service.restoreInfo(operator, 'c1', 'u1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('restoreInfo reports restorable for a deleted upload with a live parent (no path)', async () => {
    const { service } = makeService({ upload: row() });
    const info = await service.restoreInfo(sa, 'c1', 'u1');
    expect(info).toEqual({
      deleted: true,
      restorable: true,
      blockedReason: null,
    });
    expect(info).not.toHaveProperty('storagePath');
  });

  it('restoreInfo reports parent_archived and not-restorable', async () => {
    const { service, parent } = makeService({ upload: row() });
    parent.asset.mockResolvedValueOnce({ archivedAt: new Date() });
    const info = await service.restoreInfo(sa, 'c1', 'u1');
    expect(info.restorable).toBe(false);
    expect(info.blockedReason).toBe('parent_archived');
  });

  it('restoreInfo throws NotFound when the row is gone', async () => {
    const { service } = makeService({ upload: null });
    await expect(
      service.restoreInfo(sa, 'c1', 'u1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // ---- revealStoragePath (sensitive, audited disclosure) ----

  it('revealStoragePath rejects a non-SUPER_ADMIN actor without auditing', async () => {
    const { service, audit } = makeService({ upload: row() });
    await expect(
      service.revealStoragePath(operator, 'c1', 'u1', meta),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('revealStoragePath returns the storage key and audits upload.path_revealed', async () => {
    const { service, audit } = makeService({ upload: row() });
    const out = await service.revealStoragePath(sa, 'c1', 'u1', meta);
    expect(out).toEqual({ storagePath: 'c1/uploads/u1/a.png' });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'upload.path_revealed',
        entityType: 'Upload',
        entityId: 'u1',
        companyId: 'c1',
        after: { storageKey: 'c1/uploads/u1/a.png' },
      }),
    );
  });

  it('revealStoragePath throws NotFound when the row is gone and does not audit', async () => {
    const { service, audit } = makeService({ upload: null });
    await expect(
      service.revealStoragePath(sa, 'c1', 'u1', meta),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(audit.log).not.toHaveBeenCalled();
  });
});
