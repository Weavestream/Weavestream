import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { contentDispositionFor } from '../common/content-disposition.js';
import {
  assetExportColumnsSchema,
  bulkAssetIdsSchema,
  bulkCloneAssetsSchema,
  cloneAssetSchema,
  createAssetSchema,
  fieldSlugSchema,
  updateAssetSchema,
  type BulkAssetIdsInput,
  type BulkCloneAssetsInput,
  type CloneAssetInput,
  type CreateAssetInput,
  type UpdateAssetInput,
} from '@weavestream/shared';
import { AssetsService } from './assets.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { PermissionService } from '../rbac/permission.service.js';

/**
 * Company-scoped asset endpoints. Path carries `:companyId` so the
 * PermissionGuard resolves company scope via `params.companyId` and the
 * ContractorAccessGuard can reject expired contractor memberships on
 * the same request.
 *
 * `GET /companies/:companyId/assets` accepts:
 *   - `layout=<uuid>` — restrict to a single layout.
 *   - `q=<text>` (repeatable, at most 10) — each term must match; in a
 *     term, every word is a case-insensitive substring of the
 *     name or of any indexed field value (see
 *     `SearchIndexService.matchAssetIds`). Client users match only
 *     fields visible to clients.
 *   - `includeArchived=true` — includes soft-deleted assets.
 *   - `field.<slug>=<value>` — value-equality filter against that field
 *     (text types trimmed and case-insensitive; a DROPDOWN accepts the
 *     choice label or slug). Without `layout`, every layout's field with
 *     that slug counts.
 *   - `limit=<int>`, `cursor=<uuid>` — keyset pagination (bounded 1..200).
 */
@Controller({ path: 'companies/:companyId/assets', version: '1' })
export class AssetsController {
  constructor(
    private readonly assets: AssetsService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * The route decorator covers the *source* company (from the URL). The
   * target arrives in the body, so it is authorised here, explicitly, on
   * every call (CLAUDE.md §1): `asset.write` on the target, plus
   * `asset.archive` on the source when the copy is a move.
   */
  private async assertCanClone(
    actor: AuthedUser,
    sourceCompanyId: string,
    dto: CloneAssetInput,
  ): Promise<void> {
    const write = await this.permissions.can(actor, 'asset.write', {
      companyId: dto.targetCompanyId,
    });
    if (!write.allowed) {
      throw new ForbiddenException('You cannot create assets in the target company.');
    }
    if (dto.archiveOriginal) {
      const archive = await this.permissions.can(actor, 'asset.archive', {
        companyId: sourceCompanyId,
      });
      if (!archive.allowed) {
        throw new ForbiddenException('You cannot archive assets in this company.');
      }
    }
  }

  @Get()
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query() query: Record<string, string | string[] | undefined>,
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
    // Only `q` may repeat (stacked search terms). Any other key that
    // arrives repeated (an array) is ignored.
    const single = (key: string): string | undefined => {
      const value = query[key];
      return typeof value === 'string' ? value : undefined;
    };
    const q = query['q'];
    const limit = single('limit');
    return this.assets.list(actor, companyId, {
      layoutId: single('layout'),
      q: Array.isArray(q) ? q.filter((t): t is string => typeof t === 'string') : q,
      includeArchived: single('includeArchived') === 'true',
      fieldFilters,
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor: single('cursor'),
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

  /** Copy (or, with `archiveOriginal`, move) several assets into a company. */
  @Post('bulk/clone')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async bulkClone(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(bulkCloneAssetsSchema)) dto: BulkCloneAssetsInput,
    @Req() req: Request,
  ) {
    await this.assertCanClone(actor, companyId, dto);
    return this.assets.cloneMany(
      actor,
      companyId,
      dto.ids,
      dto.targetCompanyId,
      { archiveOriginal: dto.archiveOriginal },
      meta(req),
    );
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
   * Bulk hard-delete. The per-item "archive first" safety is enforced
   * server-side (WS-015): ids that are still active come back as
   * `code: "not_archived"` entries in `failed` instead of being deleted.
   * Requires `asset.purge` (FULL access) plus a fresh step-up
   * re-authentication.
   */
  @Post('bulk/purge')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.purge', { companyIdFrom: 'params.companyId' })
  @RequireStepUp()
  async bulkPurge(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(bulkAssetIdsSchema)) dto: BulkAssetIdsInput,
    @Req() req: Request,
  ) {
    return this.assets.purgeMany(actor, companyId, dto.ids, meta(req));
  }

  /**
   * CSV export of one layout's list. Same filters as `GET /` (`layout`
   * required, stacked `q`, `includeArchived=true`) plus `tag=<uuid>` —
   * the per-layout table's client-side tag filter — and
   * `columns=table|all`. See `AssetsService.exportCsv` for the row and
   * column rules. No `.csv` in the path: the edge blocks file-extension
   * probes. Routed before `:id` so `export` is not read as an id.
   */
  @Get('export')
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @Header('Cache-Control', 'private, no-store')
  async exportCsv(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query() query: Record<string, string | string[] | undefined>,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const single = (key: string): string | undefined => {
      const value = query[key];
      return typeof value === 'string' ? value : undefined;
    };
    const layoutId = z.guid().safeParse(single('layout'));
    if (!layoutId.success) {
      throw new BadRequestException({ error: 'InvalidLayout', message: 'Pick a layout to export.' });
    }
    const rawTag = single('tag');
    const tagId = rawTag === undefined ? undefined : z.guid().safeParse(rawTag);
    if (tagId && !tagId.success) {
      throw new BadRequestException({ error: 'InvalidTag', message: 'The tag filter is not valid.' });
    }
    const columns = assetExportColumnsSchema.safeParse(single('columns') ?? 'table');
    if (!columns.success) {
      throw new BadRequestException({ error: 'InvalidColumns', message: 'Use columns=table or columns=all.' });
    }
    const q = query['q'];
    const result = await this.assets.exportCsv(
      actor,
      companyId,
      {
        layoutId: layoutId.data,
        q: Array.isArray(q) ? q.filter((t): t is string => typeof t === 'string') : q,
        includeArchived: single('includeArchived') === 'true',
        tagId: tagId?.data,
        columns: columns.data,
      },
      meta(req),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', contentDispositionFor(result.filename, 'attachment'));
    if (result.truncated) res.setHeader('X-Export-Truncated', 'true');
    return new StreamableFile(Buffer.from(result.csv, 'utf8'));
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

  /** Copy (or, with `archiveOriginal`, move) one asset into a company. */
  @Post(':id/clone')
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async clone(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(cloneAssetSchema)) dto: CloneAssetInput,
    @Req() req: Request,
  ) {
    await this.assertCanClone(actor, companyId, dto);
    return this.assets.clone(
      actor,
      companyId,
      id,
      dto.targetCompanyId,
      { archiveOriginal: dto.archiveOriginal },
      meta(req),
    );
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
  @RequireStepUp()
  async purge(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    await this.assets.purge(actor, companyId, id, meta(req));
  }
}

