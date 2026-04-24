import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { StarsService, type EntityType } from './stars.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';

/**
 * Phase 9b.3 — star / unstar entities for the signed-in user.
 *
 * Mounted under `/me/stars` so it reads naturally on the frontend and
 * sits alongside `/me` preferences. Uses `@AuthedOnly` because the
 * resource scope (stars for the caller) is implicit; the service
 * applies a per-entity access check.
 *
 * Route shape:
 *   GET    /me/stars                  → list starred companies (backward compat)
 *   PUT    /me/stars/companies/:id    → star a company
 *   DELETE /me/stars/companies/:id    → unstar a company
 *   PUT    /me/stars/passwords/:id  → star a password
 *   DELETE /me/stars/passwords/:id    → unstar a password
 *   PUT    /me/stars/assets/:id       → star an asset
 *   DELETE /me/stars/assets/:id       → unstar an asset
 *   PUT    /me/stars/articles/:id     → star an article
 *   DELETE /me/stars/articles/:id     → unstar an article
 */
@Controller({ path: 'me/stars', version: '1' })
@AuthedOnly()
export class StarsController {
  constructor(private readonly stars: StarsService) {}

  @Get()
  async list(@CurrentUser() user: AuthedUser) {
    return this.stars.list(user);
  }

  // Companies
  @Put('companies/:id')
  @HttpCode(HttpStatus.OK)
  async starCompany(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.stars.star(user, 'company', id, metaFrom(req));
  }

  @Delete('companies/:id')
  @HttpCode(HttpStatus.OK)
  async unstarCompany(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.stars.unstar(user, 'company', id, metaFrom(req));
  }

  // Passwords
  @Put('passwords/:id')
  @HttpCode(HttpStatus.OK)
  async starPassword(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.stars.star(user, 'password', id, metaFrom(req));
  }

  @Delete('passwords/:id')
  @HttpCode(HttpStatus.OK)
  async unstarPassword(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.stars.unstar(user, 'password', id, metaFrom(req));
  }

  // Assets
  @Put('assets/:id')
  @HttpCode(HttpStatus.OK)
  async starAsset(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.stars.star(user, 'asset', id, metaFrom(req));
  }

  @Delete('assets/:id')
  @HttpCode(HttpStatus.OK)
  async unstarAsset(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.stars.unstar(user, 'asset', id, metaFrom(req));
  }

  // Articles
  @Put('articles/:id')
  @HttpCode(HttpStatus.OK)
  async starArticle(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.stars.star(user, 'article', id, metaFrom(req));
  }

  @Delete('articles/:id')
  @HttpCode(HttpStatus.OK)
  async unstarArticle(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.stars.unstar(user, 'article', id, metaFrom(req));
  }
}

function metaFrom(req: Request): { ip: string; userAgent: string } {
  return {
    ip: ipOf(req),
    userAgent: uaOf(req),
  };
}

function ipOf(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? '0.0.0.0';
}
function uaOf(req: Request): string {
  return (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
}
