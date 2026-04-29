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
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  createPasswordFolderSchema,
  createPasswordSchema,
  passwordFilterSchema,
  revealPasswordSchema,
  updatePasswordFolderSchema,
  updatePasswordSchema,
  type CreatePasswordFolderInput,
  type CreatePasswordInput,
  type RevealPasswordInput,
  type UpdatePasswordFolderInput,
  type UpdatePasswordInput,
} from '@weavestream/shared';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { PasswordsService } from './passwords.service.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

/**
 * Phase 10 — Passwords REST controller.
 *
 * Path: `/v1/companies/:companyId/passwords` and
 *      `/v1/companies/:companyId/password-folders`.
 *
 * All endpoints are company-scoped. Reveal + TOTP carry stricter
 * throttles than normal CRUD because they decrypt at-rest secrets —
 * we want brute-force of "reveal 10 000 records in a minute" to hit a
 * throttle wall before it becomes a data-exfil tool.
 */
@Controller({ path: 'companies/:companyId/passwords', version: '1' })
export class PasswordsController {
  constructor(private readonly passwords: PasswordsService) {}

  @Get()
  @RequirePermission('password.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query() query: Record<string, string>,
  ) {
    const filter = passwordFilterSchema.parse(query);
    const items = await this.passwords.list(actor, companyId, filter);
    return { items };
  }

  @Get(':id')
  @RequirePermission('password.read', { companyIdFrom: 'params.companyId' })
  async get(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.passwords.getDetail(actor, companyId, id);
  }

  @Get(':id/versions')
  @RequirePermission('password.read', { companyIdFrom: 'params.companyId' })
  async versions(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const items = await this.passwords.listVersions(actor, companyId, id);
    return { items };
  }

  @Post()
  @RequirePermission('password.write', { companyIdFrom: 'params.companyId' })
  async create(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createPasswordSchema)) dto: CreatePasswordInput,
    @Req() req: Request,
  ) {
    return this.passwords.create(actor, companyId, dto, meta(req));
  }

  @Patch(':id')
  @RequirePermission('password.write', { companyIdFrom: 'params.companyId' })
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updatePasswordSchema)) dto: UpdatePasswordInput,
    @Req() req: Request,
  ) {
    return this.passwords.update(actor, companyId, id, dto, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('password.archive', { companyIdFrom: 'params.companyId' })
  async archive(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.passwords.archive(actor, companyId, id, meta(req));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('password.archive', { companyIdFrom: 'params.companyId' })
  async restore(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.passwords.restore(actor, companyId, id, meta(req));
  }

  /**
   * Decrypts the password (and optionally the TOTP secret) and writes
   * a `password.revealed` audit row. Throttled to 30 reveals/min per
   * IP — tight enough that a compromised session can't scrape the
   * vault but loose enough for normal "open 5 tabs in a row" workflows.
   */
  @Post(':id/reveal')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 30, ttl: 60_000 } })
  @RequirePermission('password.reveal', { companyIdFrom: 'params.companyId' })
  async reveal(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(revealPasswordSchema)) dto: RevealPasswordInput,
    @Req() req: Request,
  ) {
    return this.passwords.reveal(actor, companyId, id, dto, meta(req));
  }

  @Post(':id/versions/:version/reveal')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 15, ttl: 60_000 } })
  @RequirePermission('password.reveal', { companyIdFrom: 'params.companyId' })
  async revealVersion(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Body(new ZodBody(revealPasswordSchema)) dto: RevealPasswordInput,
    @Req() req: Request,
  ) {
    return this.passwords.revealVersion(actor, companyId, id, version, dto, meta(req));
  }

  /**
   * Returns a fresh 6-digit code for stored TOTP records. Scoped to
   * `password.reveal` because possession of the code is equivalent to
   * possession of the shared secret for the current window. Not
   * audited — the UI auto-refreshes this while a password view is
   * open, so per-code rows would swamp the audit log. Reveals/copies
   * of the underlying secret still go through `/reveal`, which is.
   */
  @Post(':id/totp')
  @HttpCode(HttpStatus.OK)
  @Throttle({ global: { limit: 60, ttl: 60_000 } })
  @RequirePermission('password.reveal', { companyIdFrom: 'params.companyId' })
  async totp(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.passwords.generateTotpCode(actor, companyId, id);
  }

  @Post(':id/versions/:version/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('password.write', { companyIdFrom: 'params.companyId' })
  async restoreVersion(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('version', new ParseIntPipe()) version: number,
    @Req() req: Request,
  ) {
    return this.passwords.restoreVersion(actor, companyId, id, version, meta(req));
  }
}

@Controller({ path: 'companies/:companyId/password-folders', version: '1' })
export class PasswordFoldersController {
  constructor(private readonly passwords: PasswordsService) {}

  @Get()
  @RequirePermission('password.read', { companyIdFrom: 'params.companyId' })
  async list(@Param('companyId', new ParseUUIDPipe()) companyId: string) {
    const items = await this.passwords.listFolders(companyId);
    return { items };
  }

  @Post()
  @RequirePermission('password.write', { companyIdFrom: 'params.companyId' })
  async create(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createPasswordFolderSchema)) dto: CreatePasswordFolderInput,
    @Req() req: Request,
  ) {
    return this.passwords.createFolder(actor, companyId, dto, meta(req));
  }

  @Patch(':id')
  @RequirePermission('password.write', { companyIdFrom: 'params.companyId' })
  async update(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updatePasswordFolderSchema)) dto: UpdatePasswordFolderInput,
    @Req() req: Request,
  ) {
    return this.passwords.updateFolder(actor, companyId, id, dto, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('password.archive', { companyIdFrom: 'params.companyId' })
  async archive(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.passwords.archiveFolder(actor, companyId, id, meta(req));
  }
}

