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
  createArticleSchema,
  moveArticleSchema,
  updateArticleSchema,
  type CreateArticleInput,
  type MoveArticleInput,
  type UpdateArticleInput,
} from '@weavestream/shared';
import { ArticlesService } from './articles.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';

@Controller({ path: 'companies/:companyId/articles', version: '1' })
export class ArticlesController {
  constructor(private readonly articles: ArticlesService) {}

  @Get()
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query('folderId') rawFolder?: string,
    @Query('q') q?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') rawLimit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.articles.list(actor, companyId, {
      folderId: rawFolder === 'root' ? 'root' : rawFolder,
      q,
      includeArchived: includeArchived === 'true',
      limit: rawLimit ? parseInt(rawLimit, 10) : undefined,
      cursor,
    });
  }

  @Get('by-slug/:slug')
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async getBySlug(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('slug') slug: string,
  ) {
    return this.articles.getBySlug(actor, companyId, slug);
  }

  @Get(':id')
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.articles.getById(actor, companyId, id);
  }

  @Post()
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async create(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createArticleSchema)) dto: CreateArticleInput,
    @Req() req: Request,
  ) {
    return this.articles.create(actor, companyId, dto, meta(req));
  }

  @Patch(':id')
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateArticleSchema)) dto: UpdateArticleInput,
    @Req() req: Request,
  ) {
    return this.articles.update(actor, companyId, id, dto, meta(req));
  }

  @Post(':id/move')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async move(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(moveArticleSchema)) dto: MoveArticleInput,
    @Req() req: Request,
  ) {
    return this.articles.move(actor, companyId, id, dto, meta(req));
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
    return this.articles.archive(actor, companyId, id, meta(req));
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
    return this.articles.restore(actor, companyId, id, meta(req));
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
