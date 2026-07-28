import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import {
  confirmUploadSchema,
  initUploadSchema,
  uploadAttachmentTypeSchema,
  type ConfirmUploadInput,
  type InitUploadInput,
  type UploadAttachmentType,
} from '@weavestream/shared';
import { UploadsService } from './uploads.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { contentDispositionFor } from '../common/content-disposition.js';

/**
 * Company-scoped upload endpoints.
 *
 *   GET  /companies/:companyId/uploads?attachedToType=&attachedToId=
 *      → list uploads for one entity (sidebar Attachments panel).
 *        Both query params required. Requires `upload.read`.
 *   POST /companies/:companyId/uploads/init
 *      → return a same-origin relay URL (`…/uploads/:id/blob`) the
 *        browser PUTs the file body to. Requires `upload.create`.
 *   PUT  /companies/:companyId/uploads/:id/blob
 *      → relay endpoint that streams the request body to local
 *        filesystem storage. Requires `upload.create` + CSRF.
 *   POST /companies/:companyId/uploads/confirm
 *      → after the browser PUT succeeds, verify magic bytes, hash,
 *        thumbnail, and flip the pending record into an Upload row.
 *   GET  /companies/:companyId/uploads/:id/download[?attachment=1]
 *      → JSON `{ url }` pointing at the API streaming endpoint.
 *        `attachment=1` causes the URL to force a save-as dialog when
 *        followed. Kept for backwards compat with code that resolves
 *        the URL out of band; new callers should hit `…/image`
 *        directly.
 *   GET  /companies/:companyId/uploads/:id/thumbnail
 *      → JSON `{ url }` pointing at the API streaming endpoint with
 *        `?v=thumb`. Same compat note as above.
 *   GET  /companies/:companyId/uploads/:id/image[?v=thumb][&attachment=1]
 *      → stream the original (or thumbnail) bytes back through the API.
 *        Stable, embeddable, same-origin URL for `<img src>` and
 *        `<a href>` — the canonical browser-facing read endpoint.
 *        Only image bytes (thumbnails, image originals) are served
 *        `inline` and allowed into the browser disk cache; every
 *        non-image original (PDF, Office doc, archive, script,
 *        text/config) is forced to `attachment` with `no-store`.
 *        `attachment=1` forces `attachment` for images too, so a
 *        click on an image triggers a save-as instead of inline view.
 *   DELETE /companies/:companyId/uploads/:id
 *      → soft-delete.
 */
@Controller({ path: 'companies/:companyId/uploads', version: '1' })
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /**
   * Per-entity attachments list. Both `attachedToType` and
   * `attachedToId` are required — this endpoint backs the sidebar
   * Attachments panel on asset/article detail pages and deliberately
   * refuses to dump a whole tenant's uploads.
   */
  @Get()
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query('attachedToType') rawType?: string,
    @Query('attachedToId') rawId?: string,
    @Query('limit') rawLimit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const parsed = rawType ? uploadAttachmentTypeSchema.safeParse(rawType) : null;
    if (!parsed || !parsed.success || !rawId) {
      throw new BadRequestException({
        error: 'MissingAttachmentFilters',
        message:
          'attachedToType (asset|article|asset_field|password) and attachedToId are both required.',
      });
    }
    return this.uploads.listAttachments(companyId, {
      attachedToType: parsed.data,
      attachedToId: rawId,
      limit: rawLimit ? parseInt(rawLimit, 10) : undefined,
      cursor,
      actor,
    });
  }

  @Post('init')
  @RequirePermission('upload.create', { companyIdFrom: 'params.companyId' })
  async init(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(initUploadSchema)) dto: InitUploadInput,
  ) {
    return this.uploads.init(actor, companyId, dto);
  }

  /**
   * Relay PUT endpoint. The browser PUTs over the same origin with
   * normal cookie auth + CSRF, and the API streams the body to local
   * filesystem storage. The body is read as a raw stream (NestJS body
   * parsers are scoped to JSON / urlencoded content types and will not
   * consume an image or octet-stream payload).
   */
  @Put(':uploadId/blob')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('upload.create', { companyIdFrom: 'params.companyId' })
  async putBlob(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('uploadId', new ParseUUIDPipe()) uploadId: string,
    @Req() req: Request,
  ): Promise<void> {
    const declaredLength = parseInt(
      (req.headers['content-length'] as string | undefined) ?? '',
      10,
    );
    await this.uploads.relayPut(actor, companyId, uploadId, req, {
      contentType:
        typeof req.headers['content-type'] === 'string'
          ? (req.headers['content-type'] as string)
          : undefined,
      contentLength: Number.isFinite(declaredLength) ? declaredLength : undefined,
    });
  }

  @Post('confirm')
  @RequirePermission('upload.create', { companyIdFrom: 'params.companyId' })
  @HttpCode(HttpStatus.OK)
  async confirm(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(confirmUploadSchema)) dto: ConfirmUploadInput,
    @Req() req: Request,
  ) {
    return this.uploads.confirm(actor, companyId, dto, meta(req));
  }

  @Get(':id')
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.uploads.get(companyId, id, actor);
  }

  @Get(':id/download')
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async download(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('attachment') attachment?: string,
  ) {
    return this.uploads.download(companyId, id, {
      asAttachment: attachment === 'true' || attachment === '1',
      actor,
    });
  }

  @Get(':id/thumbnail')
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async thumbnail(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const url = await this.uploads.thumbnailUrl(companyId, id, actor);
    return { url };
  }

  /**
   * Stable, permanent URL suitable for `<img src>` and `<a href>`. The
   * original (or thumbnail with `?v=thumb`) is streamed back through
   * the API from local filesystem storage, so the browser never needs
   * to reach the storage layer directly. A single host-level reverse-
   * proxy entry covers the whole app.
   *
   * Disposition and caching are decided by what we actually serve:
   *   - Images (thumbnails are always WebP; image originals render in
   *     `<img>`) are sent `inline` with `private, max-age=300`, so a
   *     single user's browser can reuse the bytes for the page session.
   *   - Every non-image original (PDF, Office doc, archive, script,
   *     text/config) is forced to `Content-Disposition: attachment`
   *     with `Cache-Control: private, no-store`. Sensitive document
   *     bytes never render inline (where a content-type quirk could be
   *     abused) and are never written to the browser disk cache.
   * `attachment=1` additionally forces `attachment` for images, turning
   * the URL into a save-as link (used by the photos tile / attachments
   * panel "download" actions).
   *
   * `Cache-Control` is always `private` regardless of variant — uploaded
   * media is tenant-scoped and must always go through the API for
   * permission enforcement, so shared/CDN caches are forbidden.
   * `X-Content-Type-Options: nosniff` is set on the stream itself so the
   * declared `Content-Type` is honoured even if the web layer is bypassed.
   */
  @Get(':id/image')
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async image(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
    @Query('v') variant?: string,
    @Query('attachment') attachment?: string,
  ): Promise<StreamableFile> {
    const wantThumb = variant === 'thumb';
    const stream = await this.uploads.openImageStream(
      companyId,
      id,
      wantThumb ? 'thumb' : 'original',
      actor,
    );
    if (!stream) {
      throw new NotFoundException({
        error: wantThumb ? 'ThumbnailUnavailable' : 'UploadUnavailable',
      });
    }
    res.setHeader('Content-Type', stream.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (typeof stream.contentLength === 'number') {
      res.setHeader('Content-Length', stream.contentLength.toString());
    }
    if (stream.lastModified) {
      res.setHeader('Last-Modified', stream.lastModified.toUTCString());
    }
    if (stream.etag) {
      res.setHeader('ETag', stream.etag);
    }
    // Decide disposition + cache from the bytes we actually serve. Only
    // images are safe to render inline and worth disk-caching; every
    // non-image original is forced to download and kept out of the
    // browser cache. `attachment=1` forces a download for images too.
    const servesImage = stream.contentType.startsWith('image/');
    const asAttachment =
      attachment === '1' || attachment === 'true' || !servesImage;
    res.setHeader(
      'Content-Disposition',
      contentDispositionFor(stream.filename, asAttachment ? 'attachment' : 'inline'),
    );
    res.setHeader(
      'Cache-Control',
      servesImage ? 'private, max-age=300' : 'private, no-store',
    );
    return new StreamableFile(Readable.from(stream.body));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('upload.create', { companyIdFrom: 'params.companyId' })
  async delete(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.uploads.softDelete(actor, companyId, id, meta(req));
  }

  /**
   * Restorability for the audit-log restore panel (whether the row is
   * deleted, whether it can be restored, and if not why). SUPER_ADMIN-only
   * (enforced in the service). Deliberately does NOT return the storage
   * key — that disclosure is the separate, audited `reveal-path` endpoint
   * below.
   */
  @Get(':id/restore-info')
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async restoreInfo(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.uploads.restoreInfo(actor, companyId, id);
  }

  /**
   * Undelete a soft-deleted upload before the reaper purges it.
   * SUPER_ADMIN-only (enforced in the service); the `upload.create` guard
   * here only resolves + validates the tenant `companyId`.
   */
  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('upload.create', { companyIdFrom: 'params.companyId' })
  async restore(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.uploads.restore(actor, companyId, id, meta(req));
  }

  /**
   * Disclose an upload's internal storage path to a SUPER_ADMIN (audited in
   * the service). POST — it's a sensitive read with an audit side effect,
   * and POST keeps the path out of GET request logs, browser history, and
   * link prefetches.
   */
  @Post(':id/reveal-path')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async revealPath(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.uploads.revealStoragePath(actor, companyId, id, meta(req));
  }
}

/**
 * Per-company photos gallery. Same service, different shape — limits to
 * `isImage=true` and joins thumbnail URLs for the grid view.
 */
@Controller({ path: 'companies/:companyId/photos', version: '1' })
export class PhotosController {
  constructor(private readonly uploads: UploadsService) {}

  @Get()
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query('attachedToType') rawType?: string,
    @Query('attachedToId') rawId?: string,
    @Query('limit') rawLimit?: string,
    @Query('cursor') cursor?: string,
    @Query('includeNonLatest') rawIncludeNonLatest?: string,
  ) {
    let attachedToType: UploadAttachmentType | undefined;
    if (rawType) {
      const parsed = uploadAttachmentTypeSchema.safeParse(rawType);
      if (parsed.success) attachedToType = parsed.data;
    }
    const includeNonLatest =
      rawIncludeNonLatest === '1' || rawIncludeNonLatest === 'true';
    return this.uploads.listPhotos(companyId, {
      attachedToType,
      attachedToId: rawId,
      limit: rawLimit ? parseInt(rawLimit, 10) : undefined,
      cursor,
      actor,
      includeNonLatest,
    });
  }

  /**
   * Photos-page delete. Wrapper around `uploads.softDelete` that
   * re-checks the article link state for article-attached uploads so
   * the UI affordance (which only shows the button for orphan +
   * archived tiles) can never be tricked into removing a `live` or
   * `versioned` image. Non-article uploads delegate straight to the
   * generic soft-delete.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('upload.create', { companyIdFrom: 'params.companyId' })
  async delete(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.uploads.softDeleteFromPhotos(actor, companyId, id, meta(req));
  }
}

