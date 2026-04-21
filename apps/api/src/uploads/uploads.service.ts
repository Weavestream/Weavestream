import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { FileTypeResult } from 'file-type';
import sharp from 'sharp';

// `file-type` is pure ESM from v17 onward, but this package still emits
// CommonJS (NestJS default). A plain `await import('file-type')` would be
// transpiled by `tsc` into `require()`, which crashes at runtime with
// `ERR_REQUIRE_ESM`. Wrapping the dynamic import in `new Function` hides
// it from TypeScript's CJS down-leveling so the real ESM dynamic import
// survives to Node. The result is cached so we don't pay the import cost
// on every upload confirmation.
const dynamicImportFileType = new Function(
  'return import("file-type")',
) as () => Promise<typeof import('file-type')>;

let fileTypeModulePromise: Promise<typeof import('file-type')> | null = null;
async function fileTypeFromBuffer(
  buffer: Uint8Array,
): Promise<FileTypeResult | undefined> {
  fileTypeModulePromise ??= dynamicImportFileType();
  const mod = await fileTypeModulePromise;
  return mod.fileTypeFromBuffer(buffer);
}
import type {
  ConfirmUploadInput,
  FileFieldEntry,
  InitUploadInput,
  UploadAttachmentType,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { MinioService } from '../storage/minio.service.js';
import { RedisService } from '../redis/redis.service.js';
import { EnvService } from '../config/env.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { mimesAreCompatible } from './mime-compat.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

/** FILE-field entry with presigned URLs attached for rendering. */
export type HydratedFileFieldEntry = FileFieldEntry & {
  thumbnailUrl: string | null;
  downloadUrl: string | null;
};

export interface SerializedUpload {
  id: string;
  companyId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  isImage: boolean;
  width: number | null;
  height: number | null;
  attachedToType: string | null;
  attachedToId: string | null;
  downloadUrl: string | null;
  thumbnailUrl: string | null;
  createdAt: Date;
  uploaderId: string | null;
}

const PENDING_TTL_SECONDS = 15 * 60;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MinioService,
    private readonly redis: RedisService,
    private readonly audit: AuditLogService,
    private readonly env: EnvService,
  ) {}

  private get maxBytes(): number {
    return this.env.values.MAX_UPLOAD_MB * 1024 * 1024;
  }

  private get allowedMimes(): Set<string> {
    return new Set(
      this.env.values.ALLOWED_UPLOAD_MIME.split(',')
        .map((m) => m.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  // ------------------------------------------------------------------
  // 1) init — mint a presigned PUT URL and stash an expiry in Redis.
  // ------------------------------------------------------------------

  async init(
    actor: AuthedUser,
    companyId: string,
    input: InitUploadInput,
  ): Promise<{
    uploadId: string;
    storageKey: string;
    presignedUrl: string;
    expiresAt: Date;
  }> {
    const mime = input.mimeType.toLowerCase();
    if (!this.allowedMimes.has(mime)) {
      throw new UnsupportedMediaTypeException({
        error: 'MimeNotAllowed',
        mimeType: mime,
        message: `MIME type "${mime}" is not in the allowlist.`,
      });
    }
    if (input.sizeBytes > this.maxBytes) {
      throw new PayloadTooLargeException({
        error: 'FileTooLarge',
        sizeBytes: input.sizeBytes,
        maxBytes: this.maxBytes,
        message: `File size ${input.sizeBytes} exceeds ${this.env.values.MAX_UPLOAD_MB} MB limit.`,
      });
    }

    const uploadId = randomUUID();
    const storageKey = this.storage.uploadKey(companyId, uploadId, input.filename);
    // Only `contentType` is signed — see the note on `presignPut` for why
    // signing `ContentLength` would break the browser PUT. The declared
    // `input.sizeBytes` is still enforced by comparing against the
    // `HeadObject` `ContentLength` during `confirm`.
    const { url, expiresAt } = await this.storage.presignPut(companyId, storageKey, {
      contentType: mime,
      ttlSeconds: 300,
    });

    const pending = {
      companyId,
      filename: input.filename,
      mimeType: mime,
      sizeBytes: input.sizeBytes,
      storageKey,
      uploaderId: actor.id,
      attachedToType: input.attachedToType ?? null,
      attachedToId: input.attachedToId ?? null,
      createdAt: new Date().toISOString(),
    };
    await this.redis.client.set(
      pendingKey(uploadId),
      JSON.stringify(pending),
      'EX',
      PENDING_TTL_SECONDS,
    );

    return { uploadId, storageKey, presignedUrl: url, expiresAt };
  }

  // ------------------------------------------------------------------
  // 2) confirm — the browser PUT is done. Verify magic bytes against the
  //    declared MIME, hash the body, build a thumbnail if it's an image,
  //    then flip the pending record into a real Upload row.
  // ------------------------------------------------------------------

  async confirm(
    actor: AuthedUser,
    companyId: string,
    input: ConfirmUploadInput,
    meta: AuditMeta,
  ): Promise<SerializedUpload> {
    const raw = await this.redis.client.get(pendingKey(input.uploadId));
    if (!raw) {
      throw new NotFoundException({
        error: 'PendingUploadNotFound',
        message: 'The presigned URL has expired or does not exist.',
      });
    }
    const pending = JSON.parse(raw) as {
      companyId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
      uploaderId: string | null;
      attachedToType: UploadAttachmentType | null;
      attachedToId: string | null;
    };

    if (pending.companyId !== companyId) {
      throw new BadRequestException({
        error: 'CompanyScopeMismatch',
        message: 'Pending upload belongs to a different company.',
      });
    }

    const head = await this.storage.headObject(companyId, pending.storageKey);
    if (!head) {
      throw new BadRequestException({
        error: 'UploadNotFound',
        message: 'Object was not found in storage — did the browser PUT finish?',
      });
    }

    const actualSize = typeof head.ContentLength === 'number' ? head.ContentLength : 0;
    if (actualSize > this.maxBytes) {
      await this.storage.deleteObject(companyId, pending.storageKey).catch(() => undefined);
      throw new PayloadTooLargeException({
        error: 'FileTooLarge',
        sizeBytes: actualSize,
        maxBytes: this.maxBytes,
        message: `Stored object (${actualSize} bytes) exceeds ${this.env.values.MAX_UPLOAD_MB} MB limit.`,
      });
    }

    const body = await this.storage.getObjectBody(companyId, pending.storageKey);

    const detected = await fileTypeFromBuffer(body);
    const declaredMime = pending.mimeType.toLowerCase();
    const isTextDeclared = declaredMime.startsWith('text/');

    let finalMime = declaredMime;
    if (detected) {
      if (detected.mime === declaredMime) {
        finalMime = detected.mime;
      } else if (mimesAreCompatible(detected.mime, declaredMime)) {
        // e.g. docx/xlsx detect as application/zip; keep the declared
        // MIME so downstream consumers can render the file correctly.
        finalMime = declaredMime;
      } else {
        await this.storage.deleteObject(companyId, pending.storageKey).catch(() => undefined);
        throw new BadRequestException({
          error: 'MimeMismatch',
          declared: declaredMime,
          detected: detected.mime,
          message: `File magic bytes (${detected.mime}) do not match declared Content-Type (${declaredMime}).`,
        });
      }
    } else if (!isTextDeclared) {
      await this.storage.deleteObject(companyId, pending.storageKey).catch(() => undefined);
      throw new BadRequestException({
        error: 'MimeUndetectable',
        declared: declaredMime,
        message:
          'Could not detect a magic-bytes signature for this file. Only text/* uploads are allowed without a signature.',
      });
    }

    if (!this.allowedMimes.has(finalMime)) {
      await this.storage.deleteObject(companyId, pending.storageKey).catch(() => undefined);
      throw new UnsupportedMediaTypeException({
        error: 'MimeNotAllowed',
        mimeType: finalMime,
        message: `Detected MIME type "${finalMime}" is not in the allowlist.`,
      });
    }

    const sha256 = createHash('sha256').update(body).digest('hex');
    const isImage = finalMime.startsWith('image/');

    let width: number | null = null;
    let height: number | null = null;
    let thumbnailKey: string | null = null;

    if (isImage) {
      try {
        const pipeline = sharp(body, { failOn: 'error' });
        const meta2 = await pipeline.metadata();
        width = meta2.width ?? null;
        height = meta2.height ?? null;

        const thumb = await sharp(body)
          .rotate()
          .resize(300, 300, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        thumbnailKey = this.storage.thumbnailKey(companyId, input.uploadId);
        await this.storage.putObject(companyId, thumbnailKey, thumb, {
          contentType: 'image/webp',
        });
      } catch (err) {
        this.logger.warn(
          `Thumbnail generation failed for ${pending.storageKey}: ${(err as Error).message}`,
        );
      }
    }

    const attachedToType = input.attachedToType ?? pending.attachedToType;
    const attachedToId = input.attachedToId ?? pending.attachedToId;

    const upload = await this.prisma.upload.create({
      data: {
        id: input.uploadId,
        companyId,
        uploaderId: pending.uploaderId,
        filename: pending.filename,
        mimeType: finalMime,
        sizeBytes: actualSize,
        storageKey: pending.storageKey,
        sha256,
        isImage,
        width,
        height,
        thumbnailKey,
        attachedToType: attachedToType ?? null,
        attachedToId: attachedToId ?? null,
      },
    });

    await this.redis.client.del(pendingKey(input.uploadId)).catch(() => undefined);

    await this.audit.log({
      actorId: actor.id,
      action: 'upload.create',
      entityType: 'Upload',
      entityId: upload.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        filename: upload.filename,
        mimeType: upload.mimeType,
        sizeBytes: upload.sizeBytes,
        isImage: upload.isImage,
        attachedToType: upload.attachedToType,
        attachedToId: upload.attachedToId,
      },
    });

    // Presign the freshly-generated thumbnail so the caller (the FILE
    // dropzone tile, the rich-text image insert, etc.) can render a
    // preview immediately without a second round-trip to the
    // `/uploads/:id/thumbnail` endpoint. `serialize()` intentionally
    // leaves URL fields null — they're only populated by call sites
    // that want them, to avoid accidentally minting presigned URLs in
    // audit payloads or background jobs.
    const base = this.serialize(upload);
    base.thumbnailUrl = await this.presignThumbnail(companyId, upload.thumbnailKey);
    return base;
  }

  private async presignThumbnail(
    companyId: string,
    thumbnailKey: string | null,
  ): Promise<string | null> {
    if (!thumbnailKey) return null;
    const { url } = await this.storage.presignGet(companyId, thumbnailKey, {
      ttlSeconds: 300,
    });
    return url;
  }

  // ------------------------------------------------------------------
  // 3) download — fresh presigned GET, short TTL.
  // ------------------------------------------------------------------

  async download(
    companyId: string,
    uploadId: string,
    opts: { asAttachment?: boolean } = {},
  ): Promise<{ url: string; expiresAt: Date; filename: string; mimeType: string }> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
    });
    if (!upload) throw new NotFoundException();

    const disposition = opts.asAttachment
      ? `attachment; filename="${sanitizeForHeader(upload.filename)}"`
      : undefined;

    const { url, expiresAt } = await this.storage.presignGet(companyId, upload.storageKey, {
      ttlSeconds: 60,
      contentDisposition: disposition,
    });
    return { url, expiresAt, filename: upload.filename, mimeType: upload.mimeType };
  }

  async thumbnailUrl(companyId: string, uploadId: string): Promise<string | null> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
    });
    if (!upload || !upload.thumbnailKey) return null;
    const { url } = await this.storage.presignGet(companyId, upload.thumbnailKey, {
      ttlSeconds: 300,
    });
    return url;
  }

  // ------------------------------------------------------------------
  // 4) delete — soft-delete the Upload row. The actual bytes are left
  //    in storage so an undelete job can be added later; a cleanup job
  //    in Phase 7 will reap tombstones older than 30 days.
  // ------------------------------------------------------------------

  async softDelete(
    actor: AuthedUser,
    companyId: string,
    uploadId: string,
    meta: AuditMeta,
  ): Promise<SerializedUpload> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId },
    });
    if (!upload) throw new NotFoundException();
    if (upload.deletedAt) {
      return this.serialize(upload);
    }
    await this.prisma.upload.updateMany({
      where: { id: upload.id, companyId },
      data: { deletedAt: new Date() },
    });
    const updated = await this.prisma.upload.findFirstOrThrow({
      where: { id: upload.id, companyId },
    });

    await this.audit.log({
      actorId: actor.id,
      action: 'upload.delete',
      entityType: 'Upload',
      entityId: upload.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { deletedAt: null },
      after: { deletedAt: updated.deletedAt },
    });

    return this.serialize(updated);
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  async get(companyId: string, uploadId: string): Promise<SerializedUpload> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
    });
    if (!upload) throw new NotFoundException();
    return this.serialize(upload);
  }

  async listPhotos(
    companyId: string,
    opts: {
      attachedToType?: UploadAttachmentType;
      attachedToId?: string;
      limit?: number;
      cursor?: string;
    } = {},
  ): Promise<{ items: SerializedUpload[]; nextCursor: string | null }> {
    return this.paginatedList(companyId, { ...opts, onlyImages: true });
  }

  /**
   * Per-entity attachments list. Unlike `listPhotos`, this returns every
   * upload type (images + documents + archives + scripts) attached to a
   * specific asset or article, and **requires** both `attachedToType`
   * and `attachedToId` — we never want a tenant-wide dump from this
   * endpoint, since it backs the sidebar Attachments panel on detail
   * pages.
   */
  async listAttachments(
    companyId: string,
    opts: {
      attachedToType: UploadAttachmentType;
      attachedToId: string;
      limit?: number;
      cursor?: string;
    },
  ): Promise<{ items: SerializedUpload[]; nextCursor: string | null }> {
    if (!opts.attachedToType || !opts.attachedToId) {
      throw new BadRequestException({
        error: 'MissingAttachmentFilters',
        message: 'Both attachedToType and attachedToId are required.',
      });
    }
    return this.paginatedList(companyId, opts);
  }

  private async paginatedList(
    companyId: string,
    opts: {
      attachedToType?: UploadAttachmentType;
      attachedToId?: string;
      limit?: number;
      cursor?: string;
      onlyImages?: boolean;
    },
  ): Promise<{ items: SerializedUpload[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
    const where = {
      companyId,
      deletedAt: null,
      ...(opts.onlyImages ? { isImage: true } : {}),
      ...(opts.attachedToType ? { attachedToType: opts.attachedToType } : {}),
      ...(opts.attachedToId ? { attachedToId: opts.attachedToId } : {}),
    };
    const rows = await this.prisma.upload.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const slice = hasMore ? rows.slice(0, limit) : rows;
    const serialized = await Promise.all(
      slice.map(async (row) => {
        const base = this.serialize(row);
        // Inline content-disposition so clicking a tile opens the image
        // in a new tab's native viewer; browsers refuse to render when
        // the URL is tagged `attachment;...`, which used to make the
        // tab open-then-close on click.
        const [thumbnailUrl, download] = await Promise.all([
          this.presignThumbnail(companyId, row.thumbnailKey),
          this.storage.presignGet(companyId, row.storageKey, {
            ttlSeconds: 300,
            contentDisposition: `inline; filename="${sanitizeForHeader(row.filename)}"`,
          }),
        ]);
        base.thumbnailUrl = thumbnailUrl;
        base.downloadUrl = download.url;
        return base;
      }),
    );
    return {
      items: serialized,
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  // ------------------------------------------------------------------
  // Utility used by articles/assets when they embed an upload reference.
  // ------------------------------------------------------------------

  async findManyByIds(companyId: string, ids: string[]): Promise<SerializedUpload[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.upload.findMany({
      where: { id: { in: ids }, companyId, deletedAt: null },
    });
    return rows.map((r) => this.serialize(r));
  }

  /**
   * Hydrate a batch of FILE-field entries with fresh presigned thumbnail
   * and download URLs. The values stored in `asset_field_values.value`
   * are intentionally URL-free (URLs are ephemeral S3 signatures) — every
   * read path that needs to render a tile must call this to mint new
   * URLs. Entries that reference a deleted or cross-tenant upload are
   * kept in-place with null URLs so the tile still shows the filename
   * rather than silently disappearing.
   */
  async hydrateFileFieldEntries(
    companyId: string,
    entries: FileFieldEntry[],
  ): Promise<HydratedFileFieldEntry[]> {
    if (entries.length === 0) return [];
    const ids = Array.from(new Set(entries.map((e) => e.uploadId)));
    const rows = await this.prisma.upload.findMany({
      where: { id: { in: ids }, companyId, deletedAt: null },
      select: { id: true, storageKey: true, thumbnailKey: true, filename: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return Promise.all(
      entries.map(async (entry) => {
        const row = byId.get(entry.uploadId);
        if (!row) return { ...entry, thumbnailUrl: null, downloadUrl: null };
        const [thumbnailUrl, download] = await Promise.all([
          this.presignThumbnail(companyId, row.thumbnailKey),
          this.storage.presignGet(companyId, row.storageKey, {
            ttlSeconds: 300,
            contentDisposition: `inline; filename="${sanitizeForHeader(row.filename)}"`,
          }),
        ]);
        return { ...entry, thumbnailUrl, downloadUrl: download.url };
      }),
    );
  }

  private serialize(row: {
    id: string;
    companyId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    isImage: boolean;
    width: number | null;
    height: number | null;
    attachedToType: string | null;
    attachedToId: string | null;
    createdAt: Date;
    uploaderId: string | null;
  }): SerializedUpload {
    return {
      id: row.id,
      companyId: row.companyId,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      isImage: row.isImage,
      width: row.width,
      height: row.height,
      attachedToType: row.attachedToType,
      attachedToId: row.attachedToId,
      downloadUrl: null,
      thumbnailUrl: null,
      createdAt: row.createdAt,
      uploaderId: row.uploaderId,
    };
  }
}

function pendingKey(uploadId: string): string {
  return `upload:pending:${uploadId}`;
}

function sanitizeForHeader(filename: string): string {
  return filename.replace(/["\\]/g, '_').replace(/[\r\n]/g, '');
}
