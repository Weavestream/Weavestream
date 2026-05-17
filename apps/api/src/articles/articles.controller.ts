import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  articleSlugSchema,
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
import { ZodBody, ZodParam } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

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
    @Param('slug', new ZodParam(articleSlugSchema)) slug: string,
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

  /**
   * Hard-deletes an archived article. Mirrors `POST /assets/:id/purge` —
   * separate verb from `DELETE` so the soft archive route stays the
   * default destructive action and operators must opt in to the
   * irreversible purge from an explicit confirmation dialog. Caller
   * needs `article.purge` (FULL access).
   */
  @Post(':id/purge')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('article.purge', { companyIdFrom: 'params.companyId' })
  async purge(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.articles.purge(actor, companyId, id, meta(req));
  }

  // --------------------------------------------------------------
  // Versioning
  // --------------------------------------------------------------

  /**
   * Discard the article's in-progress autosave draft and revert the
   * live row to the most recent published version. Idempotent — a
   * `DELETE` against an article with no draft returns the current
   * state unchanged. Mirrors the soft-delete verb for an action that
   * removes operator-visible state (the unsaved edits).
   */
  @Delete(':id/draft')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async discardDraft(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.articles.discardDraft(actor, companyId, id, meta(req));
  }

  /**
   * List the published version history for an article (newest first).
   * Excludes any in-progress draft — the article detail response
   * carries that signal via `hasDraft`. Accessible to readers; the
   * tenant check inside the service rejects hidden articles for
   * CLIENT_USER.
   */
  @Get(':id/versions')
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async listVersions(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.articles.listVersions(actor, companyId, id);
  }

  /**
   * Full snapshot of a single version. Returns the version body
   * (Tiptap JSON / Markdown source) for the preview drawer in the
   * history panel.
   */
  @Get(':id/versions/:version')
  @RequirePermission('article.read', { companyIdFrom: 'params.companyId' })
  async getVersion(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('version', ParseIntPipe) version: number,
  ) {
    return this.articles.getVersion(actor, companyId, id, version);
  }

  /**
   * Re-apply a historical version's body, producing a new published
   * version (forward-only history — same shape as
   * `password.version.restored`). Any in-progress draft is dropped
   * first.
   */
  @Post(':id/versions/:version/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('article.write', { companyIdFrom: 'params.companyId' })
  async restoreVersion(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('version', ParseIntPipe) version: number,
    @Req() req: Request,
  ) {
    return this.articles.restoreVersion(actor, companyId, id, version, meta(req));
  }
}

