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
