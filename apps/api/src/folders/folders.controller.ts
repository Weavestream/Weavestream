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
  createFolderSchema,
  updateFolderSchema,
  type CreateFolderInput,
  type UpdateFolderInput,
} from '@weavestream/shared';
import { FoldersService } from './folders.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';

@Controller({ path: 'companies/:companyId/folders', version: '1' })
export class FoldersController {
  constructor(private readonly folders: FoldersService) {}

  @Get()
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async list(@Param('companyId', new ParseUUIDPipe()) companyId: string) {
    return { items: await this.folders.tree(companyId) };
  }

  @Get('tree')
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async tree(@Param('companyId', new ParseUUIDPipe()) companyId: string) {
    return { items: await this.folders.tree(companyId) };
  }

  @Get(':id')
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async get(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.folders.get(companyId, id);
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
    @Req() req: Request,
  ) {
    return this.folders.archive(actor, companyId, id, meta(req));
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

function meta(req: Request) {
  const fwd = req.headers['x-forwarded-for'];
  const ip =
    typeof fwd === 'string' && fwd.length > 0
      ? fwd.split(',')[0]!.trim()
      : req.ip ?? '0.0.0.0';
  const userAgent = (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
  return { ip, userAgent };
}
