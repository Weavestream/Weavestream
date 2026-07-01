import {
  BadRequestException,
  ConflictException,
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
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { LocalStorageService } from '../storage/local-storage.service.js';
import { RedisService } from '../redis/redis.service.js';
import { EnvService } from '../config/env.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { extractEmbeddedUploadIds } from '../articles/article-uploads.js';
import { mimesAreCompatible } from './mime-compat.js';
import { startsWithTextBom } from './text-bom.js';
import { canReadPassword } from '../passwords/password-access-policy.js';

export interface AuditMeta {
  ip: string;
  userAgent: string;
}

/** FILE-field entry with presigned URLs attached for rendering. */
export type HydratedFileFieldEntry = FileFieldEntry & {
  thumbnailUrl: string | null;
  downloadUrl: string | null;
};

export interface UploadSourceArticle {
  id: string;
  slug: string;
  title: string;
}

/**
 * Where an article-attached upload is currently reachable from. Drives
 * the photos gallery badges and the photos-page delete gate:
 *   live      — embedded in the live body of a non-archived article
 *   versioned — only in a non-draft `ArticleVersion` of a live article
 *   archived  — only reachable through an archived article (body or
 *               any of its version rows)
 *   orphan    — not referenced anywhere
 *
 * Computed only for `attachedToType === 'article'` uploads on read.
 */
export type ArticleLinkState = 'live' | 'versioned' | 'archived' | 'orphan';

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
  /**
   * Article that embeds this upload, when applicable. Populated only by
   * read paths (photos gallery / attachments lookups) for uploads whose
   * `attachedToType` is `article` — those rows never carry an
   * `attachedToId` (the article may not have existed at upload time),
   * so the source is resolved by scanning article bodies for the upload
   * URL. `null` for non-article uploads and for orphaned article
   * images that don't appear in any article body.
   *
   * Non-null for `live`, `versioned`, and `archived` link states; the
   * `archived` payload still carries the archived article's id+slug+
   * title so the UI can deep-link to the archived detail page.
   */
  sourceArticle: UploadSourceArticle | null;
  /**
   * Link state for article-attached uploads (see `ArticleLinkState`).
   * `null` for non-article uploads.
   */
  articleLinkState: ArticleLinkState | null;
}

/**
 * Why a soft-deleted upload cannot be restored. Restoring a file whose
 * parent was archived or purged would resurrect it into a broken UI
 * state, so the restore panel disables the action with a matching reason.
 */
export type UploadRestoreBlockedReason = 'parent_missing' | 'parent_archived';

/**
 * Restorability + storage location for the audit-log restore panel.
 * SUPER_ADMIN-only (see `UploadsService.restoreInfo`).
 */
export interface UploadRestoreInfo {
  /** Whether the row is currently soft-deleted. */
  deleted: boolean;
  /** True only when the row is soft-deleted AND its parent is intact. */
  restorable: boolean;
  /** Why restore is blocked; `null` when restorable or not deleted. */
  blockedReason: UploadRestoreBlockedReason | null;
}

const PENDING_TTL_SECONDS = 15 * 60;

/**
 * Bytes read from the head of a stored upload for magic-byte + BOM
 * sniffing at confirm time. Comfortably larger than `file-type`'s
 * detection window for every allowlisted format, so detection matches
 * what a full-buffer read produced — but bounded, so a 1 GB upload
 * never lands in the heap. Files smaller than this are read whole.
 */
const MAGIC_HEAD_BYTES = 64 * 1024;

@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: LocalStorageService,
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
    relayUrl: string;
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

    // Reject an attachment that names a missing or cross-company parent
    // up front, before we hand out a relay URL or write any bytes
    // (WS-013). `confirm` re-validates the resolved target, since it may
    // override what init stored.
    await this.assertAttachmentParent(
      actor,
      companyId,
      input.attachedToType ?? null,
      input.attachedToId ?? null,
    );

    const uploadId = randomUUID();
    const storageKey = this.storage.uploadKey(companyId, uploadId, input.filename);
    // Make sure the bucket exists *before* we hand the client a relay URL,
    // so the upload PUT doesn't race against bucket creation.
    await this.storage.ensureBucket(companyId);

    // Browser PUT goes to a same-origin relay endpoint on the API,
    // which streams the body to local filesystem storage. The browser
    // never touches the storage layer directly — that gives us a single
    // reverse-proxy entry for the whole app and lets us run on a
    // private filesystem path with no S3 surface.
    const expiresAt = new Date(Date.now() + PENDING_TTL_SECONDS * 1000);
    const relayUrl = `/api/v1/companies/${companyId}/uploads/${uploadId}/blob`;

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

    return { uploadId, storageKey, relayUrl, expiresAt };
  }

  // ------------------------------------------------------------------
  // 1b) relayPut — same-origin endpoint the browser PUTs the file
  //    body to. Reads the request body up to MAX_UPLOAD_MB and writes
  //    it to the local storage backend, scoped to the pending upload
  //    session in Redis.
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

    // Write-once guard: atomically claim the body slot so a second PUT
    // can't overwrite the bytes a later `confirm` validates — otherwise
    // its split reads could mix file versions or wave a payload past the
    // magic-byte gate. Released only on failure so a genuinely failed
    // PUT can retry; a hard crash self-heals via the TTL.
    const claimed = await this.redis.client.set(
      bodyKey(uploadId),
      'writing',
      'EX',
      PENDING_TTL_SECONDS,
      'NX',
    );
    if (claimed !== 'OK') {
      throw new ConflictException({
        error: 'UploadBodyAlreadyReceived',
        message: 'This upload already has a body; proceed to confirm.',
      });
    }

    // A client disconnect surfaces as a stream 'abort'; remember it so
    // we can tell a caller-side abort (400) apart from a storage/write
    // failure (5xx) once the pipeline rejects.
    let sourceAborted = false;
    body.once('aborted', () => {
      sourceAborted = true;
    });

    try {
      // Trust the pending mimeType from init for the stored object's
      // Content-Type. The browser-declared header is only a hint;
      // magic-bytes verification still happens at confirm time. The
      // body streams straight to disk under a byte-counted ceiling, so
      // it never lands in the heap.
      await this.storage.putObjectStream(companyId, pending.storageKey, body, {
        contentType: pending.mimeType,
        maxBytes: this.maxBytes,
      });
    } catch (err) {
      // Failed write: free the slot so a retry can re-claim it.
      await this.redis.client.del(bodyKey(uploadId)).catch(() => undefined);
      if (err instanceof PayloadTooLargeException) throw err;
      if (
        sourceAborted ||
        (body as { readableAborted?: boolean }).readableAborted
      ) {
        throw new BadRequestException({
          error: 'ClientAborted',
          message: 'Client aborted upload.',
        });
      }
      throw err;
    }

    // Body fully written: mark the slot done so no later PUT can
    // re-claim and overwrite it (kept until the pending TTL lapses).
    await this.redis.client.set(
      bodyKey(uploadId),
      'done',
      'EX',
      PENDING_TTL_SECONDS,
    );
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

    // Only the user who registered the pending session may confirm it.
    // `relayPut` already enforces this on the body PUT; repeating it here
    // means a confirm with a known (UUID) upload ID still cannot be
    // driven by a different user (WS-013). The controller already gated
    // on `upload.create`, so this narrows ownership rather than being the
    // primary authorization decision.
    if (pending.uploaderId && pending.uploaderId !== actor.id) {
      throw new ForbiddenException({
        error: 'UploadNotOwned',
        message: 'This upload session belongs to a different user.',
      });
    }

    // Resolve the final attachment target (confirm may override what
    // init stored) and validate the parent exists and is in scope before
    // we spend any work fetching/hashing/thumbnailing the body (WS-013).
    const attachedToType = input.attachedToType ?? pending.attachedToType;
    const attachedToId = input.attachedToId ?? pending.attachedToId;
    await this.assertAttachmentParent(
      actor,
      companyId,
      attachedToType,
      attachedToId,
    );

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

    // Read only the head for magic-byte + BOM sniffing; the full body
    // never enters the heap. The write-once guard guarantees the bytes
    // are stable across this and the streamed hash read below.
    const headBytes = await this.storage.getObjectHead(
      companyId,
      pending.storageKey,
      MAGIC_HEAD_BYTES,
    );
    if (!headBytes) {
      throw new BadRequestException({
        error: 'UploadNotFound',
        message: 'Object was not found in storage — did the browser PUT finish?',
      });
    }

    const declaredMime = pending.mimeType.toLowerCase();
    const isTextDeclared = declaredMime.startsWith('text/');
    // RFC822 email messages (.eml) are plain ASCII headers + body, so
    // `file-type` returns nothing. Treat them like text/* for the
    // "no magic bytes" fallback — the allowlist check below still
    // gates whether the operator actually wants .eml uploads.
    const isTextLikeDeclared = isTextDeclared || declaredMime === 'message/rfc822';

    let finalMime = declaredMime;

    // Fast path: a declared text/* upload that begins with a recognised
    // Unicode BOM is authoritatively text. We skip `file-type` here to
    // avoid known false positives — notably UTF-16 LE's `FF FE` prefix
    // matching the MPEG audio frame-sync pattern, which made Windows-
    // exported BitLocker Recovery Key `.txt` files fail as `audio/mpeg`.
    // The allowlist check below still runs, so only declared text MIMEs
    // already in `ALLOWED_UPLOAD_MIME` can take this path.
    if (isTextDeclared && startsWithTextBom(headBytes)) {
      // finalMime already === declaredMime; fall through to allowlist.
    } else {
      const detected = await fileTypeFromBuffer(headBytes);
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
      } else if (!isTextLikeDeclared) {
        await this.storage.deleteObject(companyId, pending.storageKey).catch(() => undefined);
        throw new BadRequestException({
          error: 'MimeUndetectable',
          declared: declaredMime,
          message:
            'Could not detect a magic-bytes signature for this file. Only text/* and message/rfc822 uploads are allowed without a signature.',
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

    // Hash by streaming the stored file through the digest so a large
    // upload never lands in the heap. The write-once guard means these
    // are the same bytes the magic-byte check above validated.
    const obj = await this.storage.getObjectStream(companyId, pending.storageKey);
    if (!obj) {
      throw new BadRequestException({
        error: 'UploadNotFound',
        message: 'Object was not found in storage — did the browser PUT finish?',
      });
    }
    const hash = createHash('sha256');
    for await (const chunk of obj.body) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const isImage = finalMime.startsWith('image/');

    let width: number | null = null;
    let height: number | null = null;
    let thumbnailKey: string | null = null;

    if (isImage) {
      try {
        // Feed `sharp` the on-disk path so libvips reads the file itself
        // (off-heap) rather than us holding the whole image Buffer. Safe
        // to open twice: the write-once guard makes the stored bytes
        // immutable for this session.
        const absPath = this.storage.getObjectPath(companyId, pending.storageKey);
        const meta2 = await sharp(absPath, { failOn: 'error' }).metadata();
        width = meta2.width ?? null;
        height = meta2.height ?? null;

        const thumb = await sharp(absPath)
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
      action: AUDIT_ACTIONS.upload.create,
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
    // works, no expiring presigned URLs to refresh, and the storage
    // backend stays private. `serialize()` intentionally leaves URL
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
    opts: { asAttachment?: boolean; actor?: AuthedUser } = {},
  ): Promise<{ url: string; filename: string; mimeType: string }> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        attachedToType: true,
        attachedToId: true,
      },
    });
    if (!upload) throw new NotFoundException();
    await this.assertReadable(companyId, upload, opts.actor);
    return {
      url: this.apiUploadUrl(companyId, upload.id, {
        attachment: opts.asAttachment,
      }),
      filename: upload.filename,
      mimeType: upload.mimeType,
    };
  }

  async thumbnailUrl(
    companyId: string,
    uploadId: string,
    actor?: AuthedUser,
  ): Promise<string | null> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
      select: {
        id: true,
        thumbnailKey: true,
        attachedToType: true,
        attachedToId: true,
      },
    });
    if (!upload) throw new NotFoundException();
    await this.assertReadable(companyId, upload, actor);
    if (!upload.thumbnailKey) return null;
    return this.apiUploadUrl(companyId, upload.id, { variant: 'thumb' });
  }

  /**
   * Stream the original or thumbnail bytes for an upload directly to
   * the caller. Used by the `<img src>` endpoint so embedded article
   * images (and any other long-lived references) render without the
   * browser ever touching the storage backend directly.
   */
  async openImageStream(
    companyId: string,
    uploadId: string,
    variant: 'original' | 'thumb',
    actor?: AuthedUser,
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
    await this.assertReadable(companyId, upload, actor);
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
    auditExtras?: Record<string, unknown>,
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
      action: AUDIT_ACTIONS.upload.delete,
      entityType: 'Upload',
      entityId: upload.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { deletedAt: null, ...auditExtras },
      after: { deletedAt: updated.deletedAt },
    });

    return this.serialize(updated);
  }

  /**
   * Photos-page soft-delete with a server-side state gate. Re-runs the
   * article link-state classifier at the moment of deletion so a stale
   * UI affordance (the delete chip should only render for `orphan`
   * and `archived` tiles) cannot bypass the rule and tombstone a
   * `live` image (which would break the article it embeds) or a
   * `versioned` image (which would break older-version restore
   * previews — see `findUploadsReferencedInHistory` in articles.service).
   *
   * Non-article uploads bypass the gate and delegate to the generic
   * soft-delete, since the photos page already supports deleting
   * detached / asset-attached images and no equivalent state exists
   * for those.
   */
  async softDeleteFromPhotos(
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
    let auditState: ArticleLinkState | null = null;
    if (upload.attachedToType === 'article' && upload.attachedToId == null) {
      const classified = await this.classifyArticleUpload(companyId, upload.id);
      const state = classified?.state ?? 'orphan';
      auditState = state;
      if (state === 'live' || state === 'versioned') {
        throw new ConflictException({
          error: 'ArticleImageStillReferenced',
          articleLinkState: state,
          message:
            state === 'live'
              ? 'This image is still embedded in a live article and cannot be deleted from the photos page.'
              : 'This image is referenced by a published article version and cannot be deleted from the photos page.',
        });
      }
    }
    return this.softDelete(actor, companyId, uploadId, meta, {
      articleLinkState: auditState,
      via: 'photos',
    });
  }

  // ------------------------------------------------------------------
  // Bulk soft-delete used by article body diffing. When an operator
  // removes an embedded image from an article, the upload it pointed
  // at is no longer reachable from the UI, so we tombstone the row
  // here. Bytes stay on disk — the Phase 7 reaper will reap the
  // storage object once the row has been soft-deleted long enough.
  // ------------------------------------------------------------------

  async softDeleteManyForArticle(
    companyId: string,
    uploadIds: string[],
  ): Promise<{ softDeleted: number }> {
    if (uploadIds.length === 0) return { softDeleted: 0 };
    const { count } = await this.prisma.upload.updateMany({
      where: {
        id: { in: uploadIds },
        companyId,
        attachedToType: 'article',
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    return { softDeleted: count };
  }

  // ------------------------------------------------------------------
  // 5) restore — undelete a soft-deleted Upload before the reaper purges
  //    it. Admin-only (SUPER_ADMIN): surfaced from the platform audit log,
  //    so the authoritative gate lives here, not in the UI. Clearing
  //    `deletedAt` drops the row from the reaper's `deletedAt < cutoff`
  //    sweep, so the reaper needs no change.
  // ------------------------------------------------------------------

  /**
   * Restore is a platform-admin safety net reachable only from the global
   * audit log. Company `upload.create` / `upload.read` membership must NOT
   * be sufficient, so enforce SUPER_ADMIN at the entry point (mirrors the
   * SA-only guard in UsersService) — independent of the company-scoped
   * `@RequirePermission` decorator, which only resolves `companyId`.
   */
  private assertRestoreAdmin(actor: AuthedUser): void {
    if (actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Restoring an upload requires SUPER_ADMIN.');
    }
  }

  /**
   * Whether a soft-deleted upload can be safely restored: a concrete
   * parent must exist AND not be archived, otherwise restoring would
   * resurrect the file into a broken UI state. Uploads with no parent (or
   * an article embed carrying no `attachedToId`) are always restorable —
   * an article image simply returns to the photos grid as an `orphan`
   * tile. Mirrors the parent lookups in `assertAttachmentParent`.
   */
  private async computeUploadRestorability(row: {
    attachedToType: string | null;
    attachedToId: string | null;
    companyId: string;
  }): Promise<{
    restorable: boolean;
    blockedReason: UploadRestoreBlockedReason | null;
  }> {
    const { attachedToType, attachedToId, companyId } = row;
    if (!attachedToType || !attachedToId) {
      return { restorable: true, blockedReason: null };
    }

    const classify = (
      parent: { archivedAt: Date | null } | null,
    ): { restorable: boolean; blockedReason: UploadRestoreBlockedReason | null } => {
      if (!parent) return { restorable: false, blockedReason: 'parent_missing' };
      if (parent.archivedAt) {
        return { restorable: false, blockedReason: 'parent_archived' };
      }
      return { restorable: true, blockedReason: null };
    };

    switch (attachedToType) {
      case 'asset':
        return classify(
          await this.prisma.asset.findFirst({
            where: { id: attachedToId, companyId },
            select: { archivedAt: true },
          }),
        );
      case 'article':
        return classify(
          await this.prisma.article.findFirst({
            where: { id: attachedToId, companyId },
            select: { archivedAt: true },
          }),
        );
      case 'asset_field':
        // AssetField is keyed globally (per layout), not per company —
        // matches the lookup in `assertAttachmentParent`.
        return classify(
          await this.prisma.assetField.findFirst({
            where: { id: attachedToId },
            select: { archivedAt: true },
          }),
        );
      case 'password':
        return classify(
          await this.prisma.password.findFirst({
            where: { id: attachedToId, companyId },
            select: { archivedAt: true },
          }),
        );
      default:
        // Unknown attachment type (shouldn't happen — closed enum at
        // write time). Treat as unrestorable rather than guess.
        return { restorable: false, blockedReason: 'parent_missing' };
    }
  }

  /**
   * Restorability for the audit-log restore panel. SUPER_ADMIN-only.
   * Intentionally does NOT return the storage path — that disclosure is a
   * separate, audited action (`revealStoragePath`) so merely opening the
   * panel doesn't leak where the bytes live. 404 when the row is already
   * gone (reaped or never existed in this company).
   */
  async restoreInfo(
    actor: AuthedUser,
    companyId: string,
    uploadId: string,
  ): Promise<UploadRestoreInfo> {
    this.assertRestoreAdmin(actor);
    const row = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId },
      select: {
        deletedAt: true,
        attachedToType: true,
        attachedToId: true,
      },
    });
    if (!row) throw new NotFoundException();
    const deleted = row.deletedAt != null;
    const { restorable, blockedReason } = await this.computeUploadRestorability({
      attachedToType: row.attachedToType,
      attachedToId: row.attachedToId,
      companyId,
    });
    return {
      deleted,
      restorable: deleted && restorable,
      blockedReason: deleted ? blockedReason : null,
    };
  }

  /**
   * Disclose an upload's internal storage key to a SUPER_ADMIN so a file
   * whose restore is blocked can still be retrieved from the data store by
   * hand. The key locates the raw bytes, so this is a sensitive read: every
   * disclosure is written to the audit log (`upload.path_revealed`),
   * satisfying the "log every use" rule for admin data-access paths — the
   * same pattern as `password.revealed`. 404 when the row is gone.
   */
  async revealStoragePath(
    actor: AuthedUser,
    companyId: string,
    uploadId: string,
    meta: AuditMeta,
  ): Promise<{ storagePath: string }> {
    this.assertRestoreAdmin(actor);
    const row = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId },
      select: { storageKey: true },
    });
    if (!row) throw new NotFoundException();

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.upload.revealPath,
      entityType: 'Upload',
      entityId: uploadId,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: { storageKey: row.storageKey },
    });

    return { storagePath: row.storageKey };
  }

  /**
   * Undelete a soft-deleted upload (SUPER_ADMIN-only). Idempotent: a row
   * that is already live is returned unchanged (mirrors `softDelete`'s own
   * idempotency). Blocked with 409 when the parent is missing/archived,
   * 404 when the row has already been reaped.
   */
  async restore(
    actor: AuthedUser,
    companyId: string,
    uploadId: string,
    meta: AuditMeta,
  ): Promise<SerializedUpload> {
    this.assertRestoreAdmin(actor);
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId },
    });
    if (!upload) throw new NotFoundException();
    if (!upload.deletedAt) {
      return this.serialize(upload);
    }

    const { restorable, blockedReason } = await this.computeUploadRestorability({
      attachedToType: upload.attachedToType,
      attachedToId: upload.attachedToId,
      companyId,
    });
    if (!restorable) {
      throw new ConflictException({
        error: 'UploadNotRestorable',
        blockedReason,
        message:
          blockedReason === 'parent_archived'
            ? 'The parent this file was attached to is archived — restore it first.'
            : 'The parent this file was attached to no longer exists.',
      });
    }

    // Conditional clear scoped to a still-deleted row: if the reaper hard-
    // deleted the row between the read above and this write, `count` is 0
    // and we resolve as gone (404) rather than resurrecting a phantom, or
    // as already-restored if a concurrent restore won the race.
    const { count } = await this.prisma.upload.updateMany({
      where: { id: upload.id, companyId, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    if (count === 0) {
      const now = await this.prisma.upload.findFirst({
        where: { id: upload.id, companyId },
      });
      if (!now) throw new NotFoundException();
      return this.serialize(now);
    }

    const updated = await this.prisma.upload.findFirstOrThrow({
      where: { id: upload.id, companyId },
    });

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.upload.restore,
      entityType: 'Upload',
      entityId: upload.id,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: { deletedAt: upload.deletedAt },
      after: { deletedAt: null },
    });

    return this.serialize(updated);
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  async get(
    companyId: string,
    uploadId: string,
    actor?: AuthedUser,
  ): Promise<SerializedUpload> {
    const upload = await this.prisma.upload.findFirst({
      where: { id: uploadId, companyId, deletedAt: null },
    });
    if (!upload) throw new NotFoundException();
    await this.assertReadable(companyId, upload, actor);
    return this.serialize(upload);
  }

  async listPhotos(
    companyId: string,
    opts: {
      attachedToType?: UploadAttachmentType;
      attachedToId?: string;
      limit?: number;
      cursor?: string;
      actor?: AuthedUser;
      includeNonLatest?: boolean;
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
      actor?: AuthedUser;
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
      actor?: AuthedUser;
      /**
       * When false (default), drop article-attached uploads whose link
       * state is not `live` from the response. The cursor still
       * advances on the underlying `Upload.id` order so the page may
       * be smaller than `limit`. Non-article rows are always shown.
       */
      includeNonLatest?: boolean;
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
    // `image` renders image bytes inline (so an image tile opens in a
    // new tab's native viewer); non-image originals are forced to
    // download by the streaming route regardless of `attachment`, so a
    // PDF/doc tile saves rather than previewing inline. Everything stays
    // on the app's own origin, unlike the previous presigned URL flow.
    const serialized = slice.map((row) => {
      const base = this.serialize(row);
      base.thumbnailUrl = row.thumbnailKey
        ? this.apiUploadUrl(companyId, row.id, { variant: 'thumb' })
        : null;
      base.downloadUrl = this.apiUploadUrl(companyId, row.id);
      return base;
    });

    // Article-attached uploads never carry an `attachedToId`, so the
    // owning article must be resolved by scanning article bodies for
    // the upload's same-origin URL. We batch the lookup across the
    // whole page so a single regex sweep covers up to `limit` photos.
    const articleUploadIds = serialized
      .filter((p) => p.attachedToType === 'article' && !p.attachedToId)
      .map((p) => p.id);
    if (articleUploadIds.length > 0) {
      const classified = await this.classifyArticleUploads(
        companyId,
        articleUploadIds,
        { visibleToClientsOnly: opts.actor?.role === 'CLIENT_USER' },
      );
      for (const item of serialized) {
        if (item.attachedToType !== 'article' || item.attachedToId) continue;
        const c = classified.get(item.id);
        if (c) {
          item.sourceArticle = c.sourceArticle;
          item.articleLinkState = c.state;
        } else {
          item.sourceArticle = null;
          item.articleLinkState = 'orphan';
        }
      }
    }

    // Actor parent-visibility filter. The cursor still advances on
    // the underlying `Upload.id` order, so the response page may be
    // smaller than `limit` — same property as the article link-state
    // filter below. Mirrors `assertReadable` rules for single-upload
    // reads so the list and the detail endpoints agree.
    const clientFiltered = opts.actor
      ? await this.filterForActor(companyId, serialized, opts.actor)
      : serialized;

    // Photos gallery: by default hide article uploads whose link state
    // isn't `live` so the grid is dominated by current content. Pass
    // `includeNonLatest` to surface orphan/archived/versioned for
    // audit + cleanup workflows. Non-article rows (assets,
    // attachments, asset-field captures) are unaffected by this
    // toggle — they have no link state concept.
    const items =
      opts.includeNonLatest === false || opts.includeNonLatest === undefined
        ? clientFiltered.filter(
            (p) =>
              p.attachedToType !== 'article' ||
              p.attachedToId != null ||
              p.articleLinkState === null ||
              p.articleLinkState === 'live',
          )
        : clientFiltered;

    return {
      items,
      nextCursor: hasMore ? slice[slice.length - 1]!.id : null,
    };
  }

  /**
   * Drop entries whose parent entity isn't readable to the actor.
   * Batches one query per parent type so the cost is bounded regardless
   * of page size. Mirrors `assertReadable`:
   *   - `asset` rows pass through (no Asset.visibleToClients flag).
   *   - `article` with attachedToId → require visible non-archived article.
   *   - `article` without attachedToId → require `state === 'live'`
   *     (already classified above for the same page).
   *   - `password` / `asset_field` → require visible non-archived parent.
   *   - null `attachedToType` → dropped.
   */
  private async filterForActor(
    companyId: string,
    serialized: SerializedUpload[],
    actor: AuthedUser,
  ): Promise<SerializedUpload[]> {
    if (serialized.length === 0) return serialized;

    const articleIds = Array.from(
      new Set(
        serialized
          .filter((p) => p.attachedToType === 'article' && p.attachedToId)
          .map((p) => p.attachedToId as string),
      ),
    );
    const passwordIds = Array.from(
      new Set(
        serialized
          .filter((p) => p.attachedToType === 'password' && p.attachedToId)
          .map((p) => p.attachedToId as string),
      ),
    );
    const assetFieldIds = Array.from(
      new Set(
        serialized
          .filter((p) => p.attachedToType === 'asset_field' && p.attachedToId)
          .map((p) => p.attachedToId as string),
      ),
    );

    const [visibleArticles, visiblePasswords, visibleAssetFields] =
      await Promise.all([
        articleIds.length
          ? this.prisma.article.findMany({
              where: {
                id: { in: articleIds },
                companyId,
                visibleToClients: true,
                archivedAt: null,
              },
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
        passwordIds.length
          ? this.prisma.password.findMany({
              where: {
                id: { in: passwordIds },
                companyId,
                archivedAt: null,
                ...(actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
              },
              select: {
                id: true,
                visibleToClients: true,
                restrictedToUserIds: true,
              },
            })
          : Promise.resolve(
              [] as Array<{
                id: string;
                visibleToClients: boolean;
                restrictedToUserIds: string[];
              }>,
            ),
        assetFieldIds.length
          ? this.prisma.assetField.findMany({
              where: {
                id: { in: assetFieldIds },
                visibleToClients: true,
                archivedAt: null,
              },
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
      ]);

    const articleOk = new Set(visibleArticles.map((r) => r.id));
    const passwordOk = new Set(
      visiblePasswords.filter((r) => canReadPassword(actor, r)).map((r) => r.id),
    );
    const assetFieldOk = new Set(visibleAssetFields.map((r) => r.id));

    return serialized.filter((p) => {
      switch (p.attachedToType) {
        case 'asset':
          return true;
        case 'article':
          if (actor.role !== 'CLIENT_USER') return true;
          if (p.attachedToId) return articleOk.has(p.attachedToId);
          return p.articleLinkState === 'live';
        case 'password':
          return p.attachedToId ? passwordOk.has(p.attachedToId) : false;
        case 'asset_field':
          if (actor.role !== 'CLIENT_USER') return true;
          return p.attachedToId ? assetFieldOk.has(p.attachedToId) : false;
        default:
          return actor.role !== 'CLIENT_USER';
      }
    });
  }

  /**
   * Classify each article-attached upload in `uploadIds` into one of
   * `live | versioned | archived | orphan` and resolve the owning
   * article when one exists. The photos gallery uses the state to
   * decide which badges, links, and delete affordances to render; the
   * photos-page delete handler uses it as a server-side gate so a
   * stale UI cannot delete a live image.
   *
   * Priority when an upload appears in multiple places:
   *   live (live body of active article)
   *     > versioned (non-draft `ArticleVersion` of active article)
   *     > archived (any reference under an archived article)
   *
   * The two scans run in parallel — each is a single regex SQL over
   * the candidate set, so the total cost is two queries regardless of
   * how many uploads are on the page.
   *
   * Visibility: when `visibleToClientsOnly`, both scans require the
   * owning article to be `visible_to_clients = TRUE` so portal
   * responses never leak titles/slugs.
   *
   * SQL safety: `uploadIds` is filtered to canonical UUIDs before being
   * inlined as a regex alternation. The company id and the regex
   * pattern itself are still bound as parameters via `Prisma.sql`.
   */
  async classifyArticleUploads(
    companyId: string,
    uploadIds: string[],
    opts: { visibleToClientsOnly?: boolean } = {},
  ): Promise<
    Map<
      string,
      { state: ArticleLinkState; sourceArticle: UploadSourceArticle | null }
    >
  > {
    const out = new Map<
      string,
      { state: ArticleLinkState; sourceArticle: UploadSourceArticle | null }
    >();
    if (uploadIds.length === 0) return out;

    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const uniqueIds = Array.from(
      new Set(uploadIds.filter((id) => uuidRe.test(id))),
    ).map((id) => id.toLowerCase());
    if (uniqueIds.length === 0) {
      // Caller still needs an entry per requested id so the read path
      // can render the orphan badge. We mark anything we couldn't even
      // shape into a UUID as orphan — there's nothing to scan against.
      for (const id of uploadIds) {
        out.set(id, { state: 'orphan', sourceArticle: null });
      }
      return out;
    }

    // `/uploads/<uuid>` is the URL shape the rich-text editor embeds
    // (see `extractEmbeddedUploadIds`). Anchoring on the path prefix
    // avoids false positives where the bare UUID appears elsewhere in
    // the article body (e.g. prose referencing an asset id).
    const pattern = `/uploads/(${uniqueIds.join('|')})`;

    const visibilityFilter = opts.visibleToClientsOnly
      ? Prisma.sql`AND a.visible_to_clients = TRUE`
      : Prisma.empty;

    const wanted = new Set(uniqueIds);

    type LiveRow = {
      id: string;
      slug: string;
      title: string;
      archived_at: Date | null;
      content_text: string | null;
      markdown_source: string | null;
    };
    type VersionRow = {
      article_id: string;
      slug: string;
      title: string;
      archived_at: Date | null;
      content_text: string | null;
      markdown_source: string | null;
    };

    const [liveRows, versionRows] = await Promise.all([
      this.prisma.$queryRaw<LiveRow[]>(Prisma.sql`
        SELECT a.id, a.slug, a.title, a.archived_at,
               a.content::text AS content_text,
               a.markdown_source
          FROM articles a
         WHERE a.company_id = ${companyId}::uuid
           ${visibilityFilter}
           AND (a.content::text ~ ${pattern} OR a.markdown_source ~ ${pattern})
      `),
      this.prisma.$queryRaw<VersionRow[]>(Prisma.sql`
        SELECT a.id          AS article_id,
               a.slug,
               a.title,
               a.archived_at,
               v.content::text AS content_text,
               v.markdown_source
          FROM article_versions v
          JOIN articles a ON a.id = v.article_id
         WHERE v.company_id = ${companyId}::uuid
           AND v.is_draft = FALSE
           ${visibilityFilter}
           AND (v.content::text ~ ${pattern} OR v.markdown_source ~ ${pattern})
      `),
    ]);

    // Aggregate by priority. We don't `break` after the first hit
    // because an upload can match against multiple article bodies and
    // we want the highest-priority owner to win.
    for (const row of liveRows) {
      const ids = extractEmbeddedUploadIds(
        row.content_text ?? row.markdown_source,
      );
      for (const id of ids) {
        if (!wanted.has(id)) continue;
        const candidate: ArticleLinkState =
          row.archived_at == null ? 'live' : 'archived';
        const existing = out.get(id);
        if (
          !existing ||
          statePriority(candidate) > statePriority(existing.state)
        ) {
          out.set(id, {
            state: candidate,
            sourceArticle: { id: row.id, slug: row.slug, title: row.title },
          });
        }
      }
    }
    for (const row of versionRows) {
      const ids = extractEmbeddedUploadIds(
        row.content_text ?? row.markdown_source,
      );
      for (const id of ids) {
        if (!wanted.has(id)) continue;
        const candidate: ArticleLinkState =
          row.archived_at == null ? 'versioned' : 'archived';
        const existing = out.get(id);
        if (
          !existing ||
          statePriority(candidate) > statePriority(existing.state)
        ) {
          out.set(id, {
            state: candidate,
            sourceArticle: {
              id: row.article_id,
              slug: row.slug,
              title: row.title,
            },
          });
        }
      }
    }

    for (const id of uploadIds) {
      if (!out.has(id)) out.set(id, { state: 'orphan', sourceArticle: null });
    }
    return out;
  }

  /**
   * Single-upload wrapper around `classifyArticleUploads` used by the
   * photos-page delete gate. Recomputes link state at the moment of
   * deletion (inside the same Prisma client / transaction) so a stale
   * UI cannot trick the server into removing a live or history-only
   * image. Returns `null` when the upload is not an article-attached
   * row (caller proceeds without the gate).
   */
  async classifyArticleUpload(
    companyId: string,
    uploadId: string,
  ): Promise<{
    state: ArticleLinkState;
    sourceArticle: UploadSourceArticle | null;
  } | null> {
    const result = await this.classifyArticleUploads(companyId, [uploadId]);
    return result.get(uploadId) ?? null;
  }

  /**
   * @deprecated Prefer `classifyArticleUploads` which also reports the
   * link state. Kept as a back-compat shim that returns only the
   * `sourceArticle` map for callers that don't need state. Note that
   * the state-aware classifier now includes archived articles in the
   * source resolution as well, so this returns sources for any state
   * other than `orphan`.
   */
  async findUploadSourceArticles(
    companyId: string,
    uploadIds: string[],
    opts: { visibleToClientsOnly?: boolean } = {},
  ): Promise<Map<string, UploadSourceArticle>> {
    const classified = await this.classifyArticleUploads(
      companyId,
      uploadIds,
      opts,
    );
    const out = new Map<string, UploadSourceArticle>();
    for (const [id, entry] of classified) {
      if (entry.sourceArticle) out.set(id, entry.sourceArticle);
    }
    return out;
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

  /**
   * Validate an upload's declared attachment parent before we persist
   * the pointer. Upload IDs are unguessable UUIDs, but server-side
   * invariants must not lean on unguessability (WS-013) — an attachment
   * naming a missing or cross-company parent is rejected here rather
   * than producing an orphaned or misleading row.
   *
   *   asset       → Asset must exist in this company.
   *   article     → Article must exist in this company.
   *   asset_field → AssetField must exist. The field is a global,
   *                 company-agnostic template (no `companyId` column of
   *                 its own), so existence is the only invariant
   *                 available here; company scope for FILE-field uploads
   *                 is carried by the owning asset, which is backfilled
   *                 into `attachedToId` once the asset saves.
   *   password    → Password must exist in this company AND be readable
   *                 by the actor, matching the password-detail read
   *                 policy (`canReadPassword`, see WS-001). A credential
   *                 the actor cannot read must not gain an attachment
   *                 pointing at it.
   *
   * A null `attachedToId` is always allowed: every article image and any
   * asset uploaded from the new-asset form is confirmed before its
   * owning row exists (the id is linked/resolved afterwards), so there
   * is nothing to validate against yet.
   */
  private async assertAttachmentParent(
    actor: AuthedUser,
    companyId: string,
    attachedToType: UploadAttachmentType | null,
    attachedToId: string | null,
  ): Promise<void> {
    if (!attachedToType || !attachedToId) return;

    const reject = (): never => {
      throw new BadRequestException({
        error: 'AttachmentParentInvalid',
        attachedToType,
        message:
          'The attachment target does not exist or is not in this company.',
      });
    };

    switch (attachedToType) {
      case 'asset': {
        const row = await this.prisma.asset.findFirst({
          where: { id: attachedToId, companyId },
          select: { id: true },
        });
        if (!row) reject();
        return;
      }
      case 'article': {
        const row = await this.prisma.article.findFirst({
          where: { id: attachedToId, companyId },
          select: { id: true },
        });
        if (!row) reject();
        return;
      }
      case 'asset_field': {
        const row = await this.prisma.assetField.findFirst({
          where: { id: attachedToId },
          select: { id: true },
        });
        if (!row) reject();
        return;
      }
      case 'password': {
        const row = await this.prisma.password.findFirst({
          where: { id: attachedToId, companyId },
          select: {
            id: true,
            visibleToClients: true,
            restrictedToUserIds: true,
          },
        });
        if (!row || !canReadPassword(actor, row)) reject();
        return;
      }
    }
  }

  /**
   * Parent-visibility gate for CLIENT_USER on every upload read path.
   * Other roles pass through. The upload row's `companyId` + `upload.read`
   * permission already proves tenant membership; this check ensures a
   * client portal member cannot fetch bytes/metadata for an upload
   * attached to content that is hidden from them.
   *
   *   article + attachedToId  → require visible, non-archived article
   *   article + null attached → require live-state embed in a visible
   *                             article body (no archived/versioned)
   *   password                → require visible, non-archived password
   *   asset_field             → require visible, non-archived field
   *   asset                   → allowed (Asset has no visibleToClients)
   *   null attachedToType     → denied (no parent to authorize against)
   *
   * All failures throw NotFoundException to avoid leaking existence,
   * matching the pattern used by ArticlesService and PasswordsService.
   */
  private async assertReadable(
    companyId: string,
    upload: {
      id: string;
      attachedToType: string | null;
      attachedToId: string | null;
    },
    actor?: AuthedUser,
  ): Promise<void> {
    if (!actor) return;

    const deny = () => {
      throw new NotFoundException();
    };

    switch (upload.attachedToType) {
      case 'asset':
        return;
      case 'password': {
        if (!upload.attachedToId) return deny();
        const row = await this.prisma.password.findFirst({
          where: {
            id: upload.attachedToId,
            companyId,
            archivedAt: null,
            ...(actor.role === 'CLIENT_USER' ? { visibleToClients: true } : {}),
          },
          select: {
            id: true,
            visibleToClients: true,
            restrictedToUserIds: true,
          },
        });
        if (!row || !canReadPassword(actor, row)) return deny();
        return;
      }
      case 'asset_field': {
        if (actor.role !== 'CLIENT_USER') return;
        if (!upload.attachedToId) return deny();
        const row = await this.prisma.assetField.findFirst({
          where: {
            id: upload.attachedToId,
            visibleToClients: true,
            archivedAt: null,
          },
          select: { id: true },
        });
        if (!row) return deny();
        return;
      }
      case 'article': {
        if (actor.role !== 'CLIENT_USER') return;
        if (upload.attachedToId) {
          const row = await this.prisma.article.findFirst({
            where: {
              id: upload.attachedToId,
              companyId,
              visibleToClients: true,
              archivedAt: null,
            },
            select: { id: true },
          });
          if (!row) return deny();
          return;
        }
        const classified = await this.classifyArticleUploads(
          companyId,
          [upload.id],
          { visibleToClientsOnly: true },
        );
        const entry = classified.get(upload.id);
        if (!entry || entry.state !== 'live') return deny();
        return;
      }
      default:
        return actor.role === 'CLIENT_USER' ? deny() : undefined;
    }
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
      sourceArticle: null,
      articleLinkState: null,
    };
  }
}

function pendingKey(uploadId: string): string {
  return `upload:pending:${uploadId}`;
}

/**
 * Marks that an upload session's body has been (or is being) written.
 * `SET NX` on this key is the write-once guard: the first relay PUT
 * claims it and later PUTs are rejected, so the bytes `confirm`
 * validates can't be swapped underneath it.
 */
function bodyKey(uploadId: string): string {
  return `upload:body:${uploadId}`;
}

/**
 * Resolution priority when an article upload appears in multiple
 * places. Higher wins; `orphan` is the implicit floor so it never
 * needs to compete against a found state.
 */
function statePriority(state: ArticleLinkState): number {
  switch (state) {
    case 'live':
      return 3;
    case 'versioned':
      return 2;
    case 'archived':
      return 1;
    case 'orphan':
      return 0;
  }
}
