import { Controller, Get, Query } from '@nestjs/common';
import { ActivityService } from './activity.service.js';
import {
  CurrentUser,
  type AuthedUser,
} from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';

/**
 * Phase 9b.3 — `/activity/recent` powers the operator home-dashboard
 * feed. Operator scope is enforced by the tenant interceptor + the
 * service layer; CLIENT users are rejected in-service.
 */
@Controller({ path: 'activity', version: '1' })
@AuthedOnly()
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get('recent')
  async recent(
    @CurrentUser() user: AuthedUser,
    @Query('limit') limit?: string,
  ) {
    const parsed = limit ? Number.parseInt(limit, 10) : 10;
    const safe = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
    return this.activity.recent(user, safe);
  }
}
