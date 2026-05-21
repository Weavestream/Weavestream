import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
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
import { isPrivatePeer, requestMetaOf } from '../common/request-meta.js';
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
   * Bypasses authentication (the web container has no API session) but
   * is restricted to internal TCP peers (loopback / link-local / RFC1918
   * / IPv6 ULA + loopback / link-local). The peer address is the
   * underlying socket — not spoofable through `X-Forwarded-For` — so
   * we don't need a shared secret. Standard Docker / private-network
   * deployments where the web and API containers share a bridge
   * already satisfy this; deployments that route web→API over the
   * public internet will need to add an explicit reverse-proxy hop.
   */
  @Get('active')
  @Public()
  async active(@Req() req: Request) {
    if (!isPrivatePeer(req.socket.remoteAddress)) {
      throw new ForbiddenException();
    }
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
