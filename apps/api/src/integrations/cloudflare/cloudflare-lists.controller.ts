import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  cloudflareAddEntrySchema,
  cloudflareOverwriteSchema,
  cloudflareRemoveEntrySchema,
  cloudflareUpdateEntrySchema,
  registerCloudflareListSchema,
  type CloudflareAddEntryInput,
  type CloudflareOverwriteInput,
  type CloudflareRemoveEntryInput,
  type CloudflareUpdateEntryInput,
  type RegisterCloudflareListInput,
} from '@weavestream/shared';
import { ZodBody } from '../../common/zod-validation.pipe.js';
import {
  CurrentUser,
  type AuthedUser,
} from '../../common/current-user.decorator.js';
import { RequirePermission } from '../../rbac/require-permission.decorator.js';
import { requestMetaOf as meta } from '../../common/request-meta.js';
import { CloudflareListsService } from './cloudflare-lists.service.js';

/**
 * Cloudflare Rules Lists admin REST surface.
 *
 * Mounted under the existing /v1/admin/integrations namespace so the
 * Cloudflare integration row is treated like any other integration for
 * CRUD + credentials, but list-management routes live here. Every route
 * is gated by `integration.manage` (SUPER_ADMIN-only).
 */
@Controller({
  path: 'admin/integrations/:id/cloudflare',
  version: '1',
})
export class CloudflareListsController {
  constructor(private readonly lists: CloudflareListsService) {}

  /** Browse Cloudflare-side IP lists so the operator can pick which to register. */
  @Get('external-lists')
  @RequirePermission('integration.manage')
  externalLists(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.lists.listExternalLists(id).then((lists) => ({ lists }));
  }

  @Get('lists')
  @RequirePermission('integration.manage')
  list(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.lists.listRegisteredLists(id);
  }

  @Post('lists')
  @RequirePermission('integration.manage')
  register(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(registerCloudflareListSchema))
    dto: RegisterCloudflareListInput,
    @Req() req: Request,
  ) {
    return this.lists.registerList(user, id, dto.externalListId, meta(req));
  }

  @Get('lists/:listId')
  @RequirePermission('integration.manage')
  get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('listId', new ParseUUIDPipe()) listId: string,
  ) {
    return this.lists.getRegisteredList(id, listId);
  }

  @Delete('lists/:listId')
  @RequirePermission('integration.manage')
  @HttpCode(204)
  async unregister(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('listId', new ParseUUIDPipe()) listId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.lists.unregisterList(user, id, listId, meta(req));
  }

  @Post('lists/:listId/entries')
  @RequirePermission('integration.manage')
  addEntry(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('listId', new ParseUUIDPipe()) listId: string,
    @Body(new ZodBody(cloudflareAddEntrySchema)) dto: CloudflareAddEntryInput,
    @Req() req: Request,
  ) {
    return this.lists.addEntry(
      user,
      id,
      listId,
      { ip: dto.ip, description: dto.description ?? '' },
      dto.entriesVersion,
      meta(req),
    );
  }

  @Patch('lists/:listId/entries/:entryKey')
  @RequirePermission('integration.manage')
  updateEntry(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('listId', new ParseUUIDPipe()) listId: string,
    @Param('entryKey') entryKey: string,
    @Body(new ZodBody(cloudflareUpdateEntrySchema))
    dto: CloudflareUpdateEntryInput,
    @Req() req: Request,
  ) {
    return this.lists.updateEntry(
      user,
      id,
      listId,
      decodeURIComponent(entryKey),
      { ip: dto.ip, description: dto.description ?? '' },
      dto.entriesVersion,
      meta(req),
    );
  }

  @Delete('lists/:listId/entries/:entryKey')
  @RequirePermission('integration.manage')
  removeEntry(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('listId', new ParseUUIDPipe()) listId: string,
    @Param('entryKey') entryKey: string,
    @Body(new ZodBody(cloudflareRemoveEntrySchema))
    dto: CloudflareRemoveEntryInput,
    @Req() req: Request,
  ) {
    return this.lists.removeEntry(
      user,
      id,
      listId,
      decodeURIComponent(entryKey),
      dto.entriesVersion,
      meta(req),
    );
  }

  @Post('lists/:listId/drift-check')
  @RequirePermission('integration.manage')
  driftCheck(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('listId', new ParseUUIDPipe()) listId: string,
    @Req() req: Request,
  ) {
    return this.lists.runDriftCheck(id, listId, user, meta(req));
  }

  @Post('lists/:listId/overwrite-cloudflare')
  @RequirePermission('integration.manage')
  overwrite(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('listId', new ParseUUIDPipe()) listId: string,
    @Body(new ZodBody(cloudflareOverwriteSchema))
    dto: CloudflareOverwriteInput,
    @Req() req: Request,
  ) {
    return this.lists.overwriteCloudflare(
      user,
      id,
      listId,
      dto.entriesVersion,
      meta(req),
    );
  }
}
