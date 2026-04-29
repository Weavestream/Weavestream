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
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createTagSchema,
  updateTagSchema,
  type CreateTagInput,
  type UpdateTagInput,
} from '@weavestream/shared';
import { TagsService } from './tags.service.js';
import {
  CurrentUser,
  type AuthedUser,
} from '../common/current-user.decorator.js';
import {
  AuthedOnly,
  RequirePermission,
} from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

/**
 * Global Tag surface. List + upsert are `@AuthedOnly` so any user can pick
 * an existing tag or coin a new one while editing an asset; rename and
 * delete require `tag.manage.global` (TAG_MANAGE / SUPER_ADMIN).
 */
@Controller({ path: 'tags', version: '1' })
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @AuthedOnly()
  async list(
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return {
      items: await this.tags.list({
        q,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      }),
    };
  }

  @Post()
  @AuthedOnly()
  @HttpCode(HttpStatus.OK)
  async create(
    @CurrentUser() actor: AuthedUser,
    @Body(new ZodBody(createTagSchema)) dto: CreateTagInput,
    @Req() req: Request,
  ) {
    return this.tags.create(actor, dto.name, meta(req));
  }

  @Patch(':id')
  @RequirePermission('tag.manage.global')
  async rename(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateTagSchema)) dto: UpdateTagInput,
    @Req() req: Request,
  ) {
    return this.tags.rename(actor, id, dto.name, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('tag.manage.global')
  async remove(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    await this.tags.remove(actor, id, meta(req));
  }
}

