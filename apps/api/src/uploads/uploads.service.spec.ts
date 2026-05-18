import {
  BadRequestException,
  ConflictException,
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
      headObject: jest.fn(),
      getObjectBody: jest.fn(),
      deleteObject: jest.fn(),
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
    expect(storage.putObject).toHaveBeenCalledWith(
      'c1',
      'c1/uploads/u-1/a.png',
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
