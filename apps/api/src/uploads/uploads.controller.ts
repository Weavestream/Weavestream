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
  Query,
  Redirect,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
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

/**
 * Company-scoped upload endpoints.
 *
 *   GET  /companies/:companyId/uploads?attachedToType=&attachedToId=
 *      → list uploads for one entity (sidebar Attachments panel).
 *        Both query params required. Requires `upload.read`.
 *   POST /companies/:companyId/uploads/init
 *      → mint a presigned PUT URL. Requires `upload.create`.
 *   POST /companies/:companyId/uploads/confirm
 *      → after the browser PUT succeeds, verify magic bytes, hash,
 *        thumbnail, and flip the pending record into an Upload row.
 *   GET  /companies/:companyId/uploads/:id/download
 *      → presigned GET URL (60s TTL). Requires `upload.read`.
 *   GET  /companies/:companyId/uploads/:id/thumbnail
 *      → presigned GET URL for the thumbnail (300s TTL).
 *   GET  /companies/:companyId/uploads/:id/image[?v=thumb]
 *      → 302 to a fresh presigned GET URL. Stable, embeddable URL for
 *        `<img src>`; used by the rich-text editor so article content
 *        never stores expiring signed URLs.
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
          'attachedToType (asset|article|asset_field) and attachedToId are both required.',
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
   * Stable, permanent URL suitable for `<img src>`. Every hit re-mints a
   * short-TTL presigned S3 GET and 302-redirects the browser to it, so
   * article content can embed a long-lived reference (`/uploads/:id/image`)
   * without worrying about signature expiry. `?v=thumb` opts into the
   * thumbnail variant; otherwise the original file is served inline.
   *
   * Uses Nest's `@Redirect()` decorator — the default URL is a placeholder
   * that gets overridden per-request by the `{ url, statusCode }` returned
   * from the handler.
   */
  @Get(':id/image')
  @Redirect('about:blank', HttpStatus.FOUND)
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async image(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('v') variant?: string,
  ): Promise<{ url: string; statusCode: number }> {
    if (variant === 'thumb') {
      const url = await this.uploads.thumbnailUrl(companyId, id);
      if (!url) throw new NotFoundException({ error: 'ThumbnailUnavailable' });
      return { url, statusCode: HttpStatus.FOUND };
    }
    const download = await this.uploads.download(companyId, id, {
      asAttachment: false,
    });
    return { url: download.url, statusCode: HttpStatus.FOUND };
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
 * Per-company photos gallery. Same service, different shape — limits to
 * `isImage=true` and joins thumbnail URLs for the grid view.
 */
@Controller({ path: 'companies/:companyId/photos', version: '1' })
export class PhotosController {
  constructor(private readonly uploads: UploadsService) {}

  @Get()
  @RequirePermission('upload.read', { companyIdFrom: 'params.companyId' })
  async list(
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
    });
  }
}

function meta(req: Request) {
  const fwd = req.headers['x-forwarded-for'];
  const ip =
    typeof fwd === 'string' && fwd.length > 0
      ? fwd.split(',')[0]!.trim()
      : req.ip ?? '0.0.0.0';
  const userAgent = (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
  return { ip, userAgent };
}
