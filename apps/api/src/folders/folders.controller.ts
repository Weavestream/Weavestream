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
} from '@nestjs/common';
import type { Request } from 'express';
import {
  archiveFolderSchema,
  createFolderSchema,
  updateFolderSchema,
  type ArchiveFolderInput,
  type CreateFolderInput,
  type UpdateFolderInput,
} from '@weavestream/shared';
import { FoldersService } from './folders.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

@Controller({ path: 'companies/:companyId/folders', version: '1' })
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
  ) {
    return { items: await this.folders.tree(actor, companyId) };
  }

  @Get('tree')
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async tree(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
  ) {
    return { items: await this.folders.tree(actor, companyId) };
  }

  @Get(':id')
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.folders.get(actor, companyId, id);
  }

  @Post()
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async create(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createFolderSchema)) dto: CreateFolderInput,
    @Req() req: Request,
  ) {
    return this.folders.create(actor, companyId, dto, meta(req));
  }

  @Patch(':id')
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateFolderSchema)) dto: UpdateFolderInput,
    @Req() req: Request,
  ) {
    return this.folders.update(actor, companyId, id, dto, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async archive(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(archiveFolderSchema)) dto: ArchiveFolderInput,
    @Req() req: Request,
  ) {
    return this.folders.archive(actor, companyId, id, dto, meta(req));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async restore(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.folders.restore(actor, companyId, id, meta(req));
  }
}

