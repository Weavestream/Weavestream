import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
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
 *        `attachment=1` switches `Content-Disposition` to `attachment`
 *        with the original filename so a click triggers a download
 *        instead of inline rendering.
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
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.uploads.get(companyId, id);
  }

  @Get(':id/download')
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async download(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('attachment') attachment?: string,
  ) {
    return this.uploads.download(companyId, id, {
      asAttachment: attachment === 'true' || attachment === '1',
    });
  }

  @Get(':id/thumbnail')
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async thumbnail(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const url = await this.uploads.thumbnailUrl(companyId, id);
    return { url };
  }

  /**
   * Stable, permanent URL suitable for `<img src>` and `<a href>`. The
   * original (or thumbnail with `?v=thumb`) is streamed back through
   * the API from local filesystem storage, so the browser never needs
   * to reach the storage layer directly. A single host-level reverse-
   * proxy entry covers the whole app.
   *
   * `attachment=1` flips `Content-Disposition` to `attachment` with
   * the original filename, turning the URL into a save-as link
   * (used by the photos tile / attachments panel "download" actions).
   * Without it the response is `inline`, so an image renders in an
   * `<img>` tag and a click on a PDF/doc opens it in a new tab.
   *
   * Sets a private `Cache-Control` so a single user's browser can
   * reuse the bytes for the lifetime of the page session, while
   * shared/CDN caches are forbidden — uploaded media is tenant-scoped
   * and must always go through the API for permission enforcement.
   */
  @Get(':id/image')
  @Header('Cache-Control', 'private, max-age=300')
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async image(
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
    );
    if (!stream) {
      throw new NotFoundException({
        error: wantThumb ? 'ThumbnailUnavailable' : 'UploadUnavailable',
      });
    }
    res.setHeader('Content-Type', stream.contentType);
    if (typeof stream.contentLength === 'number') {
      res.setHeader('Content-Length', stream.contentLength.toString());
    }
    if (stream.lastModified) {
      res.setHeader('Last-Modified', stream.lastModified.toUTCString());
    }
    if (stream.etag) {
      res.setHeader('ETag', stream.etag);
    }
    const asAttachment = attachment === '1' || attachment === 'true';
    res.setHeader(
      'Content-Disposition',
      contentDispositionFor(stream.filename, asAttachment ? 'attachment' : 'inline'),
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
}

/**
 * Build a `Content-Disposition` header value for a streamed upload.
 * Sanitises the filename (newlines and quotes break the header) and
 * also emits an RFC 5987 `filename*` so non-ASCII names round-trip
 * correctly across browsers.
 */
function contentDispositionFor(
  filename: string,
  mode: 'inline' | 'attachment',
): string {
  const fallback = filename.replace(/["\\]/g, '_').replace(/[\r\n]/g, '');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${mode}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
  ) {
    let attachedToType: UploadAttachmentType | undefined;
    if (rawType) {
      const parsed = uploadAttachmentTypeSchema.safeParse(rawType);
      if (parsed.success) attachedToType = parsed.data;
    }
    return this.uploads.listPhotos(companyId, {
      attachedToType,
      attachedToId: rawId,
      limit: rawLimit ? parseInt(rawLimit, 10) : undefined,
      cursor,
      actor,
    });
  }
}

