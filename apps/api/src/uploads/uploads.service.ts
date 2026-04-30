import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
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
import { startsWithTextBom } from './text-bom.js';

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
  // 1) init — register a pending upload and return a same-origin URL
  //    the browser will PUT the file body to.
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
    // Make sure the bucket exists *before* we hand the client a relay URL,
    // so the upload PUT doesn't race against bucket creation.
    await this.storage.ensureBucket(companyId);

    // Browser PUT goes to a same-origin relay endpoint instead of a
    // presigned MinIO URL. This keeps MinIO fully internal (Docker
    // compose pins the S3 port to 127.0.0.1 by default) and removes
    // the operational burden of fronting the bucket endpoint with a
    // reverse proxy + CSP/CORS just so browsers can PUT to it.
    const expiresAt = new Date(Date.now() + PENDING_TTL_SECONDS * 1000);
    const presignedUrl = `/api/v1/companies/${companyId}/uploads/${uploadId}/blob`;

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

    return { uploadId, storageKey, presignedUrl, expiresAt };
  }

  // ------------------------------------------------------------------
  // 1b) relayPut — same-origin replacement for the previous browser →
  //    MinIO presigned PUT. Reads the request body up to MAX_UPLOAD_MB
  //    and writes it to the internal MinIO endpoint, scoped to the
  //    pending upload session in Redis.
  // ------------------------------------------------------------------

  async relayPut(
    actor: AuthedUser,
    companyId: string,
    uploadId: string,
    body: Readable,
    headers: { contentType?: string; contentLength?: number },
  ): Promise<void> {
    const raw = await this.redis.client.get(pendingKey(uploadId));
    if (!raw) {
      throw new NotFoundException({
        error: 'PendingUploadNotFound',
        message: 'The upload session has expired or does not exist.',
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
    // Only the user who created the pending session may PUT against it.
    // The init endpoint already gated on `upload.create`, so this is a
    // narrowing check rather than the primary authorization decision.
    if (pending.uploaderId && pending.uploaderId !== actor.id) {
      throw new ForbiddenException({
        error: 'UploadNotOwned',
        message: 'This upload session belongs to a different user.',
      });
    }

    if (
      typeof headers.contentLength === 'number' &&
      Number.isFinite(headers.contentLength) &&
      headers.contentLength > this.maxBytes
    ) {
      throw new PayloadTooLargeException({
        error: 'FileTooLarge',
        sizeBytes: headers.contentLength,
        maxBytes: this.maxBytes,
        message: `File size ${headers.contentLength} exceeds ${this.env.values.MAX_UPLOAD_MB} MB limit.`,
      });
    }

    const buffer = await readBoundedStream(body, this.maxBytes);

    // Trust the pending mimeType from init for the stored object's
    // Content-Type. The browser-declared header is only a hint; magic-
    // bytes verification still happens at confirm time.
    await this.storage.putObject(companyId, pending.storageKey, buffer, {
      contentType: pending.mimeType,
    });
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

    const declaredMime = pending.mimeType.toLowerCase();
    const isTextDeclared = declaredMime.startsWith('text/');

    let finalMime = declaredMime;

    // Fast path: a declared text/* upload that begins with a recognised
    // Unicode BOM is authoritatively text. We skip `file-type` here to
    // avoid known false positives — notably UTF-16 LE's `FF FE` prefix
    // matching the MPEG audio frame-sync pattern, which made Windows-
    // exported BitLocker Recovery Key `.txt` files fail as `audio/mpeg`.
    // The allowlist check below still runs, so only declared text MIMEs
    // already in `ALLOWED_UPLOAD_MIME` can take this path.
    if (isTextDeclared && startsWithTextBom(body)) {
      // finalMime already === declaredMime; fall through to allowlist.
    } else {
      const detected = await fileTypeFromBuffer(body);
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

    // Browsers always render uploaded media through the API streaming
    // endpoint (`…/image[?v=thumb]`). The client just sees a stable,
    // same-origin URL — `<img src>` works, `<a href target=_blank>`
    // works, no expiring presigned URLs to refresh, and MinIO never
    // needs a public origin. `serialize()` intentionally leaves URL
    // fields null so we don't bake URLs into audit payloads or
    // background jobs that don't care.
    const base = this.serialize(upload);
    base.thumbnailUrl = upload.thumbnailKey
      ? this.apiUploadUrl(companyId, upload.id, { variant: 'thumb' })
      : null;
    base.downloadUrl = this.apiUploadUrl(companyId, upload.id);
    return base;
  }

  /**
   * Same-origin streaming URL for an upload. The public API path
   * mirrors the `image` controller route (`/uploads/:id/image`) and
   * accepts `?v=thumb` for the 300px webp preview and `?attachment=1`
   * for a save-as `Content-Disposition`. Callers store these strings
   * straight into the response body — they never expire and never
   * point at a private bucket origin.
   */
  private apiUploadUrl(
    companyId: string,
    uploadId: string,
    opts: { variant?: 'thumb'; attachment?: boolean } = {},
  ): string {
    const params = new URLSearchParams();
    if (opts.variant === 'thumb') params.set('v', 'thumb');
    if (opts.attachment) params.set('attachment', '1');
    const qs = params.toString();
    const base = `/api/v1/companies/${companyId}/uploads/${uploadId}/image`;
    return qs ? `${base}?${qs}` : base;
  }

  // ------------------------------------------------------------------
  // 3) download / thumbnail — same-origin URLs pointing at the API
  //    streaming endpoint. Kept as JSON-returning endpoints for back
  //    compat with code that resolves the URL out of band; new
  //    callers should hit `…/image` directly.
  // ------------------------------------------------------------------

  async download(
    companyId: string,
    uploadId: string,
    opts: { asAttachment?: boolean } = {},
  ): Promise<{ url: string; filename: string; mimeType: string }> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
      select: { id: true, filename: true, mimeType: true },
    });
    if (!upload) throw new NotFoundException();
    return {
      url: this.apiUploadUrl(companyId, upload.id, {
        attachment: opts.asAttachment,
      }),
      filename: upload.filename,
      mimeType: upload.mimeType,
    };
  }

  async thumbnailUrl(companyId: string, uploadId: string): Promise<string | null> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
      select: { id: true, thumbnailKey: true },
    });
    if (!upload || !upload.thumbnailKey) return null;
    return this.apiUploadUrl(companyId, upload.id, { variant: 'thumb' });
  }

  /**
   * Stream the original or thumbnail bytes for an upload directly to
   * the caller. Used by the `<img src>` endpoint so embedded article
   * images (and any other long-lived references) render without the
   * browser ever needing to reach MinIO.
   */
  async openImageStream(
    companyId: string,
    uploadId: string,
    variant: 'original' | 'thumb',
  ): Promise<{
    body: AsyncIterable<Uint8Array>;
    contentType: string;
    contentLength?: number;
    lastModified?: Date;
    etag?: string;
    filename: string;
  } | null> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
    });
    if (!upload) return null;
    const key = variant === 'thumb' ? upload.thumbnailKey : upload.storageKey;
    if (!key) return null;
    const stream = await this.storage.getObjectStream(companyId, key);
    if (!stream) return null;
    return {
      body: stream.body,
      contentType:
        stream.contentType ??
        (variant === 'thumb' ? 'image/webp' : upload.mimeType) ??
        'application/octet-stream',
      contentLength: stream.contentLength,
      lastModified: stream.lastModified,
      etag: stream.etag,
      filename: upload.filename,
    };
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
    // Stable same-origin URLs pointing at the API streaming endpoint.
    // `image` (no `attachment=1`) sends inline Content-Disposition, so
    // clicking a tile opens the file in a new tab's native viewer
    // (image renders, PDF previews, etc.) just like the previous
    // presigned URL flow did, while staying on the app's own origin.
    const serialized = slice.map((row) => {
      const base = this.serialize(row);
      base.thumbnailUrl = row.thumbnailKey
        ? this.apiUploadUrl(companyId, row.id, { variant: 'thumb' })
        : null;
      base.downloadUrl = this.apiUploadUrl(companyId, row.id);
      return base;
    });
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
   * Hydrate a batch of FILE-field entries with same-origin API
   * `thumbnailUrl` and `downloadUrl` values. The values stored in
   * `asset_field_values.value` are intentionally URL-free — every
   * read path that needs to render a tile calls this. Entries that
   * reference a deleted or cross-tenant upload are kept in-place with
   * null URLs so the tile still shows the filename rather than
   * silently disappearing.
   */
  async hydrateFileFieldEntries(
    companyId: string,
    entries: FileFieldEntry[],
  ): Promise<HydratedFileFieldEntry[]> {
    if (entries.length === 0) return [];
    const ids = Array.from(new Set(entries.map((e) => e.uploadId)));
    const rows = await this.prisma.upload.findMany({
      where: { id: { in: ids }, companyId, deletedAt: null },
      select: { id: true, thumbnailKey: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return entries.map((entry) => {
      const row = byId.get(entry.uploadId);
      if (!row) return { ...entry, thumbnailUrl: null, downloadUrl: null };
      return {
        ...entry,
        thumbnailUrl: row.thumbnailKey
          ? this.apiUploadUrl(companyId, row.id, { variant: 'thumb' })
          : null,
        downloadUrl: this.apiUploadUrl(companyId, row.id),
      };
    });
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

/**
 * Read a Node Readable stream into a Buffer, rejecting once the
 * cumulative size exceeds `maxBytes`. We can't trust a client's
 * declared `Content-Length`, so this is the real ceiling — even if a
 * malicious caller lies about the length we'll still tear the
 * connection down before the body grows past the configured limit.
 */
async function readBoundedStream(stream: Readable, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const settle = (err: Error | null, buf?: Buffer) => {
      if (settled) return;
      settled = true;
      if (err) {
        stream.destroy(err);
        reject(err);
      } else {
        resolve(buf!);
      }
    };

    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      received += buf.length;
      if (received > maxBytes) {
        settle(
          new PayloadTooLargeException({
            error: 'FileTooLarge',
            sizeBytes: received,
            maxBytes,
            message: `Upload body exceeds ${maxBytes} bytes.`,
          }),
        );
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => settle(null, Buffer.concat(chunks)));
    stream.on('error', (err) => settle(err));
    stream.on('aborted', () =>
      settle(new BadRequestException({ error: 'ClientAborted', message: 'Client aborted upload.' })),
    );
  });
}
