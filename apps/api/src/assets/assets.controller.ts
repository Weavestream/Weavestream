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
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createAssetSchema,
  updateAssetSchema,
  type CreateAssetInput,
  type UpdateAssetInput,
} from '@weavestream/shared';
import { AssetsService } from './assets.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';

/**
 * Company-scoped asset endpoints. Path carries `:companyId` so the
 * PermissionGuard resolves company scope via `params.companyId` and the
 * ContractorAccessGuard can reject expired contractor memberships on
 * the same request.
 *
 * `GET /companies/:companyId/assets` accepts:
 *   - `layout=<uuid>` — restrict to a single layout.
 *   - `q=<text>` — case-insensitive substring match on `Asset.name`
 *     (Phase 6 expands this to field values via tsvector).
 *   - `includeArchived=true` — includes soft-deleted assets.
 *   - `field.<slug>=<value>` — value-equality filter against that field.
 *   - `limit=<int>`, `cursor=<uuid>` — keyset pagination (bounded 1..200).
 */
@Controller({ path: 'companies/:companyId/assets', version: '1' })
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get()
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    // Use a null-prototype object so attacker-supplied `field.<slug>` keys
    // such as `__proto__` or `constructor` cannot pollute Object.prototype.
    const fieldFilters: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(query)) {
      if (!key.startsWith('field.') || typeof value !== 'string') continue;
      const slug = key.slice('field.'.length);
      if (slug === '__proto__' || slug === 'prototype' || slug === 'constructor') continue;
      fieldFilters[slug] = value;
    }
    return this.assets.list(actor, companyId, {
      layoutId: query['layout'],
      q: query['q'],
      includeArchived: query['includeArchived'] === 'true',
      fieldFilters,
      limit: query['limit'] ? parseInt(query['limit'], 10) : undefined,
      cursor: query['cursor'],
    });
  }

  /**
   * Per-layout asset count map for the company, used by the
   * company-scoped sidebar. Cheap groupBy — callers treat a missing
   * layout id as zero. Must be declared before `:id` so the `id`
   * route doesn't swallow the `counts-by-layout` literal.
   */
  @Get('counts-by-layout')
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async countsByLayout(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
  ) {
    return this.assets.countsByLayout(companyId);
  }

  @Get(':id')
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.assets.get(actor, companyId, id);
  }

  @Post()
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async create(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createAssetSchema)) dto: CreateAssetInput,
    @Req() req: Request,
  ) {
    return this.assets.create(actor, companyId, dto, meta(req));
  }

  @Patch(':id')
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateAssetSchema)) dto: UpdateAssetInput,
    @Req() req: Request,
  ) {
    return this.assets.update(actor, companyId, id, dto, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.archive', { companyIdFrom: 'params.companyId' })
  async archive(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.assets.archive(actor, companyId, id, meta(req));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.archive', { companyIdFrom: 'params.companyId' })
  async restore(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.assets.restore(actor, companyId, id, meta(req));
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
