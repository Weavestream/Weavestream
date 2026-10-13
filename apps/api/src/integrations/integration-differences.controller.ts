import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  integrationDifferencesQuerySchema,
  resolveIntegrationDifferenceSchema,
  resolveIntegrationDifferencesBulkSchema,
  type IntegrationDifferencesQuery,
  type ResolveIntegrationDifferenceInput,
  type ResolveIntegrationDifferencesBulkInput,
} from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { IntegrationDifferencesService } from './integration-differences.service.js';

/** Asset page: resolve one difference. Company scope comes from the path. */
@Controller({ path: 'companies/:companyId/assets/:assetId/integration-differences', version: '1' })
export class AssetIntegrationDifferencesController {
  constructor(private readonly differences: IntegrationDifferencesService) {}

  @Post('resolve')
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  @HttpCode(200)
  resolve(
    @CurrentUser() user: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('assetId', new ParseUUIDPipe()) assetId: string,
    @Body(new ZodBody(resolveIntegrationDifferenceSchema)) dto: ResolveIntegrationDifferenceInput,
    @Req() req: Request,
  ) {
    return this.differences.resolve(user, companyId, assetId, dto, meta(req));
  }
}

/** Admin > Integrations > Differences: every open difference of one integration. */
@Controller({ path: 'admin/integrations', version: '1' })
export class IntegrationDifferencesController {
  constructor(private readonly differences: IntegrationDifferencesService) {}

  @Get(':id/differences')
  @RequirePermission('integration.manage')
  list(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(new ZodBody(integrationDifferencesQuerySchema)) query: IntegrationDifferencesQuery,
  ) {
    return this.differences.list(id, query);
  }

  /** Bulk Use source / Keep ours; asset.write is checked per company inside. */
  @Post(':id/differences/resolve-bulk')
  @RequirePermission('integration.manage')
  @HttpCode(200)
  resolveBulk(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(resolveIntegrationDifferencesBulkSchema)) dto: ResolveIntegrationDifferencesBulkInput,
    @Req() req: Request,
  ) {
    return this.differences.resolveBulk(user, id, dto, meta(req));
  }
}
