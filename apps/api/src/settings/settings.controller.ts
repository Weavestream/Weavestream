import { Body, Controller, Get, Patch, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import {
  updateApiKeysSettingSchema,
  updateMcpClientPolicySchema,
  updateMcpRemoteSettingSchema,
  updatePasswordAccessPolicySchema,
  updateSettingsSchema,
  type UpdateApiKeysSettingInput,
  type UpdateMcpClientPolicyInput,
  type PasswordAccessPolicy,
  type UpdateMcpRemoteSettingInput,
  type UpdatePasswordAccessPolicyInput,
  type UpdateSettingsInput,
} from '@weavestream/shared';
import { SettingsService } from './settings.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import {
  AuthedOnly,
  RequirePermission,
} from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf } from '../common/request-meta.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { InteractiveOnly } from '../auth/interactive-only.decorator.js';

@Controller({ path: 'settings', version: '1' })
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Read-only. Every authenticated user loads settings once per page
   * render to resolve the workspace chip + tenant term, so this must
   * be fast and cheap — see the 5s in-process cache in SettingsService.
   */
  @Get()
  @AuthedOnly()
  async get() {
    return this.settings.get();
  }

  /**
   * SUPER_ADMIN-only. The permission guard enforces the role check;
   * the Zod schema enforces the shape.
   */
  @Patch()
  @RequirePermission('settings.manage')
  async update(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateSettingsSchema)) dto: UpdateSettingsInput,
    @Req() req: Request,
  ) {
    return this.settings.update(user, dto, requestMetaOf(req));
  }

  /**
   * Turn API key (Bearer token) authentication on or off for the instance.
   * Its own route rather than a field on the PATCH above because it changes
   * who can reach the API at all: it needs a recent step-up, and an API key
   * can never call it (a key must not be able to switch keys on or off).
   */
  @Put('api-keys')
  @RequirePermission('settings.manage')
  @RequireStepUp()
  @InteractiveOnly()
  async setApiKeys(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateApiKeysSettingSchema)) dto: UpdateApiKeysSettingInput,
    @Req() req: Request,
  ) {
    return this.settings.setApiKeysEnabled(user, dto.enabled, requestMetaOf(req));
  }

  /**
   * Turn remote MCP connections (AI apps over OAuth) on or off for the
   * instance. Same rules as the API key switch above: step-up, and never
   * reachable by an API key or a connection.
   */
  @Put('mcp-remote')
  @RequirePermission('settings.manage')
  @RequireStepUp()
  @InteractiveOnly()
  async setMcpRemote(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateMcpRemoteSettingSchema)) dto: UpdateMcpRemoteSettingInput,
    @Req() req: Request,
  ) {
    return this.settings.setMcpRemoteEnabled(user, dto.enabled, requestMetaOf(req));
  }

  /**
   * Choose which AI apps may connect to `/mcp`: Claude and ChatGPT only, or
   * any MCP app. Same rules as the switch above: step-up, and never reachable
   * by an API key or a connection.
   */
  @Put('mcp-client-policy')
  @RequirePermission('settings.manage')
  @RequireStepUp()
  @InteractiveOnly()
  async setMcpClientPolicy(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updateMcpClientPolicySchema)) dto: UpdateMcpClientPolicyInput,
    @Req() req: Request,
  ) {
    return this.settings.setMcpClientPolicy(user, dto.policy, requestMetaOf(req));
  }

  /**
   * The global password access policy with its user list and the users that
   * can be picked. `settings.manage` only: the list is never part of the
   * public `GET /settings`.
   */
  @Get('password-access-policy')
  @RequirePermission('settings.manage')
  async getPasswordAccessPolicy(): Promise<PasswordAccessPolicy> {
    const [policy, users] = await Promise.all([
      this.settings.passwordAccessPolicy(),
      this.settings.listPasswordAccessUsers(),
    ]);
    return { mode: policy.mode, userIds: [...policy.userIds], users };
  }

  /**
   * Change who can open password entries that have no own allow-list.
   * Same rules as the switches above: step-up, and never reachable by an
   * API key or a connection. Returns success only — no echo of the input.
   */
  @Put('password-access-policy')
  @RequirePermission('settings.manage')
  @RequireStepUp()
  @InteractiveOnly()
  async setPasswordAccessPolicy(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(updatePasswordAccessPolicySchema)) dto: UpdatePasswordAccessPolicyInput,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    await this.settings.setPasswordAccessPolicy(user, dto, requestMetaOf(req));
    return { ok: true };
  }
}
