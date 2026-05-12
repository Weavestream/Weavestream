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
  bulkAssetIdsSchema,
  createAssetSchema,
  fieldSlugSchema,
  updateAssetSchema,
  type BulkAssetIdsInput,
  type CreateAssetInput,
  type UpdateAssetInput,
} from '@weavestream/shared';
import { AssetsService } from './assets.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

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
    // Build the filter map from a validated entry list rather than
    // dynamic bracket-writes. `fieldSlugSchema` enforces the canonical
    // lowercase snake_case shape used by `AssetField.slug`, which by
    // construction rejects reserved keys like `__proto__`, `prototype`,
    // and `constructor` — so prototype pollution is impossible.
    const fieldFilters: Record<string, string> = Object.fromEntries(
      Object.entries(query).flatMap(([key, value]) => {
        if (!key.startsWith('field.') || typeof value !== 'string') return [];
        const slug = key.slice('field.'.length);
        return fieldSlugSchema.safeParse(slug).success
          ? ([[slug, value]] as const)
          : [];
      }),
    );
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

  /**
   * Bulk-archive assets. Reuses the per-item archive path under the hood
   * (so search index, password cascade, audit log all stay consistent)
   * and returns a `{ ok, failed }` report rather than 4xx-ing on partial
   * failure — the UI surfaces a "8 archived, 2 failed" toast.
   *
   * Routed before `:id` so the literal `bulk` segment doesn't get
   * swallowed by the UUID-typed id matcher.
   */
  @Post('bulk/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.archive', { companyIdFrom: 'params.companyId' })
  async bulkArchive(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(bulkAssetIdsSchema)) dto: BulkAssetIdsInput,
    @Req() req: Request,
  ) {
    return this.assets.archiveMany(actor, companyId, dto.ids, meta(req));
  }

  @Post('bulk/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.archive', { companyIdFrom: 'params.companyId' })
  async bulkRestore(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(bulkAssetIdsSchema)) dto: BulkAssetIdsInput,
    @Req() req: Request,
  ) {
    return this.assets.restoreMany(actor, companyId, dto.ids, meta(req));
  }

  /**
   * Bulk hard-delete. Bypasses the per-item "archive first" safety
   * because the UI already gates this action behind a typed-confirmation
   * dialog; making the operator archive twice (once before purge, once
   * before bulk purge) would be unnecessary friction. Caller still needs
   * `asset.purge` (FULL access).
   */
  @Post('bulk/purge')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.purge', { companyIdFrom: 'params.companyId' })
  async bulkPurge(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(bulkAssetIdsSchema)) dto: BulkAssetIdsInput,
    @Req() req: Request,
  ) {
    return this.assets.purgeMany(actor, companyId, dto.ids, meta(req));
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

  /**
   * Hard-delete an archived asset. POST (not DELETE) so the unscoped
   * `DELETE /:id` keeps its archive semantics — operators have to
   * archive first, then opt into the irreversible purge from a
   * different verb. The asset must already be `archivedAt != null`;
   * the service throws 400 otherwise.
   */
  @Post(':id/purge')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('asset.purge', { companyIdFrom: 'params.companyId' })
  async purge(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    await this.assets.purge(actor, companyId, id, meta(req));
  }
}

