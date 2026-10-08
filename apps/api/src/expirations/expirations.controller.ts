import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  dismissExpirationSchema,
  type DismissExpirationInput,
  type ExpirationRow,
} from '@weavestream/shared';
import { ExpirationDismissalsService } from './expiration-dismissals.service.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';
import { ExpirationsService } from './expirations.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';

/**
 * Company-scoped "Expiring soon" feed.
 *
 * Requires `asset.read` on the target company — the same permission
 * the assets list and sidebar counts already use, so a viewer who
 * can see the company's assets can see the derived expiring rows
 * without any new RBAC wiring.
 */
@Controller({ path: 'companies/:companyId/expirations', version: '1' })
export class CompanyExpirationsController {
  constructor(
    private readonly expirations: ExpirationsService,
    private readonly dismissals: ExpirationDismissalsService,
  ) {}

  @Get()
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query('includeDismissed') includeDismissed?: string,
  ): Promise<{ items: ExpirationRow[] }> {
    const items = await this.expirations.list({
      actor,
      companyId,
      includeDismissed: includeDismissed === '1' || includeDismissed === 'true',
    });
    return { items };
  }

  /**
   * Hide one row for its current due date. The route only proves the actor
   * can read the company; the service checks the per-kind manage permission
   * and that the item really belongs to this company.
   */
  @Post('dismissals')
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async dismiss(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(dismissExpirationSchema)) dto: DismissExpirationInput,
    @Req() req: Request,
  ) {
    const d = await this.dismissals.dismiss(actor, companyId, dto, meta(req));
    return { id: d.id };
  }

  @Delete('dismissals/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async restore(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.dismissals.restore(actor, companyId, id, meta(req));
  }
}

/**
 * Cross-company "Expiring soon" feed.
 *
 * Only SUPER_ADMIN reaches this endpoint — same belt-and-braces guard
 * as `DomainsAlertsController.alerts`. `asset.read` without a company
 * scope isn't a legitimate grant for any other role; keeping the check
 * inside the handler makes that intent obvious to future readers.
 */
@Controller({ path: 'expirations', version: '1' })
export class GlobalExpirationsController {
  constructor(private readonly expirations: ExpirationsService) {}

  @Get()
  @RequirePermission('asset.read')
  async list(
    @CurrentUser() actor: AuthedUser,
    @Query('includeDismissed') includeDismissed?: string,
  ): Promise<{ items: ExpirationRow[] }> {
    if (actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'cross-company expirations feed is SUPER_ADMIN-only',
      );
    }
    const items = await this.expirations.list({
      actor,
      includeDismissed: includeDismissed === '1' || includeDismissed === 'true',
    });
    return { items };
  }
}
