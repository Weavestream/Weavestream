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
  Req,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  type IpRuleBlockedReport,
  type IpRuleInput,
  type IpRulePatch,
  ipRuleBlockedReportSchema,
  ipRuleInputSchema,
  ipRulePatchSchema,
} from '@weavestream/shared';
import { IpRulesService } from './ip-rules.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';
import { InternalOnlyGuard } from '../common/internal-only.guard.js';
import { Public, SkipCsrf } from '../common/public.decorator.js';

/**
 * Admin IP rules management.
 *
 * All endpoints require `IP_RULE_MANAGE` capability (or SUPER_ADMIN).
 * Rules are enforced globally by IpRuleGuard before AuthGuard.
 */
@Controller({ path: 'ip-rules', version: '1' })
export class IpRulesController {
  constructor(private readonly ipRules: IpRulesService) {}

  @Get()
  @RequirePermission('ip_rule.manage')
  async list() {
    return { items: await this.ipRules.list() };
  }

  /**
   * Internal endpoint polled by the Next.js `proxy.ts` so a DENY rule
   * blocks page renders, not just API calls. Returns the same cached
   * ruleset `IpRuleGuard` is enforcing so the two layers stay in sync.
   *
   * Internal-only: gated by `InternalOnlyGuard`, which requires BOTH an
   * internal TCP peer AND a valid `x-ws-internal-token` (derived from
   * `COOKIE_SIGNING_KEY`). The peer check alone is not a boundary here —
   * the web tier is a blind reverse proxy on the same bridge, so a
   * proxied internet request has the web container as its socket peer and
   * would pass a peer-only check. The web proxy 404s this path before it
   * forwards, and the token is the API-side backstop. (WS-028)
   */
  @Get('active')
  @Public()
  @UseGuards(InternalOnlyGuard)
  async active() {
    return { rules: await this.ipRules.getActiveRulesCached() };
  }

  /**
   * Internal endpoint the Next.js `proxy.ts` calls when IT denies a
   * page load under a DENY rule — those requests never reach the API,
   * so without this report they would be invisible to the audit trail
   * and to the "IP blocked or rate limited" security alert. Same
   * internal-auth model as `/active` above (WS-028): private peer AND
   * `x-ws-internal-token`, and the web proxy 404s the path for browser
   * traffic.
   *
   * Three decorators are load-bearing:
   *  - `@SkipCsrf()`: unlike `/active` this is a POST, and `@Public()`
   *    does not exempt CSRF — without it every report 403s.
   *  - `@SkipThrottle({ global: true })`: every report shares the web
   *    container's peer identity, so a distributed scan would exhaust
   *    one global bucket and emit a misleading `ratelimit.blocked` row
   *    about this endpoint itself. `InternalOnlyGuard` remains the
   *    boundary, and `recordBlockedRequest` is claimOnce-coalesced, so
   *    the endpoint's work is bounded regardless.
   *  - The blocked IP arrives in the BODY, never in `x-forwarded-for`:
   *    `IpRuleGuard` runs first on every request and would 403 a
   *    report presenting the denied IP as its own.
   *
   * 204 is returned only after the audit row is durable (the service
   * awaits the write), so the proxy's `waitUntil` completes truthfully.
   */
  @Post('blocked-report')
  @Public()
  @SkipCsrf()
  @SkipThrottle({ global: true })
  @UseGuards(InternalOnlyGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async blockedReport(
    @Body(new ZodBody(ipRuleBlockedReportSchema)) dto: IpRuleBlockedReport,
  ): Promise<void> {
    await this.ipRules.recordBlockedRequest(
      {
        ip: dto.ip,
        cidr: dto.cidr,
        priority: dto.priority,
        path: dto.path,
        userAgent: dto.userAgent,
      },
      'web',
    );
  }

  @Get(':id')
  @RequirePermission('ip_rule.manage')
  async get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.ipRules.getById(id);
  }

  @Post()
  @RequirePermission('ip_rule.manage')
  async create(
    @CurrentUser() actor: AuthedUser,
    @Body(new ZodBody(ipRuleInputSchema)) dto: IpRuleInput,
    @Req() req: Request,
  ) {
    return this.ipRules.create(actor, dto, requestMetaOf(req));
  }

  @Patch(':id')
  @RequirePermission('ip_rule.manage')
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ipRulePatchSchema)) dto: IpRulePatch,
    @Req() req: Request,
  ) {
    return this.ipRules.update(actor, id, dto, requestMetaOf(req));
  }

  @Delete(':id')
  @RequirePermission('ip_rule.manage')
  async delete(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.ipRules.delete(actor, id, requestMetaOf(req));
  }
}
