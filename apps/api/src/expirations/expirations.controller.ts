import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ExpirationsService, type ExpirationRow } from './expirations.service.js';
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
  constructor(private readonly expirations: ExpirationsService) {}

  @Get()
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
  ): Promise<{ items: ExpirationRow[] }> {
    const items = await this.expirations.list({ actor, companyId });
    return { items };
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
  ): Promise<{ items: ExpirationRow[] }> {
    if (actor.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'cross-company expirations feed is SUPER_ADMIN-only',
      );
    }
    const items = await this.expirations.list({ actor });
    return { items };
  }
}
