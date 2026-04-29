import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createAssetLayoutSchema,
  updateAssetLayoutSchema,
  reorderAssetLayoutsSchema,
  saveAssetFieldsSchema,
  type CreateAssetLayoutInput,
  type UpdateAssetLayoutInput,
  type ReorderAssetLayoutsInput,
  type SaveAssetFieldsInput,
} from '@weavestream/shared';
import { AssetLayoutsService } from './asset-layouts.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import {
  AuthedOnly,
  RequirePermission,
} from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

/**
 * Phase 3 global AssetLayout surface. Reads are `@AuthedOnly` (every
 * authenticated role can list/get layouts so forms and lists render);
 * mutations require `layout.manage.global` which is SUPER_ADMIN-only per
 * the permission matrix. Integration tests assert 403 for every other
 * role on every mutation route.
 *
 * `?stats=true` on the single-layout endpoint extends the response with
 * field / asset / company counts — the builder uses this to power the
 * `v<version> · N fields · used by M assets in K companies` subtitle.
 */
@Controller({ path: 'layouts', version: '1' })
export class AssetLayoutsController {
  constructor(private readonly layouts: AssetLayoutsService) {}

  @Get()
  @AuthedOnly()
  async list(
    @Query('q') q?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return {
      items: await this.layouts.list({
        q,
        includeArchived: includeArchived === 'true',
      }),
    };
  }

  @Get(':id')
  @AuthedOnly()
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query('stats') stats?: string,
  ) {
    const layout = await this.layouts.get(id);
    if (stats === 'true' && actor.role === 'SUPER_ADMIN') {
      return { layout, stats: await this.layouts.stats(id) };
    }
    return { layout };
  }

  @Post()
  @RequirePermission('layout.manage.global')
  async create(
    @CurrentUser() actor: AuthedUser,
    @Body(new ZodBody(createAssetLayoutSchema)) dto: CreateAssetLayoutInput,
    @Req() req: Request,
  ) {
    return this.layouts.create(actor, dto, meta(req));
  }

  // NOTE: `reorder` must be declared *above* `@Patch(':id')` — Nest
  // matches routes in declaration order, and `'reorder'` is not a
  // UUID, so without this the :id route would intercept and 400 on
  // the ParseUUIDPipe.
  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('layout.manage.global')
  async reorder(
    @CurrentUser() actor: AuthedUser,
    @Body(new ZodBody(reorderAssetLayoutsSchema)) dto: ReorderAssetLayoutsInput,
    @Req() req: Request,
  ) {
    return { items: await this.layouts.reorder(actor, dto.orderedIds, meta(req)) };
  }

  @Patch(':id')
  @RequirePermission('layout.manage.global')
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateAssetLayoutSchema)) dto: UpdateAssetLayoutInput,
    @Req() req: Request,
  ) {
    return this.layouts.update(actor, id, dto, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('layout.manage.global')
  async archive(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.layouts.archive(actor, id, meta(req));
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('layout.manage.global')
  async archiveExplicit(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.layouts.archive(actor, id, meta(req));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('layout.manage.global')
  async restore(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.layouts.restore(actor, id, meta(req));
  }

  @Put(':id/fields')
  @RequirePermission('layout.manage.global')
  async saveFields(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(saveAssetFieldsSchema)) dto: SaveAssetFieldsInput,
    @Query('force') force: string | undefined,
    @Req() req: Request,
  ) {
    return this.layouts.saveFields(
      actor,
      id,
      dto,
      { force: force === 'true' },
      meta(req),
    );
  }
}

