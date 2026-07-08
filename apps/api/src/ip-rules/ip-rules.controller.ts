import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  type IpRuleInput,
  type IpRulePatch,
  ipRuleInputSchema,
  ipRulePatchSchema,
} from '@weavestream/shared';
import { IpRulesService } from './ip-rules.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';
import { InternalOnlyGuard } from '../common/internal-only.guard.js';
import { Public } from '../common/public.decorator.js';

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
