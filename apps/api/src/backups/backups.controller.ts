import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  type BackupConfig,
  type BackupConfigInput,
  type BackupConfigPatch,
  type BackupRunDto,
  backupConfigInputSchema,
  backupConfigPatchSchema,
} from '@weavestream/shared';
import { BackupsService } from './backups.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { requestMetaOf } from '../common/request-meta.js';

const listRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    configId: z.string().uuid().optional(),
  })
  .strict();

/**
 * Admin endpoints for the scheduled Postgres export feature.
 *
 * Every route is gated by `backup.manage`, which resolves to the new
 * `BACKUP_MANAGE` platform capability (or SUPER_ADMIN). Holders can
 * download raw database dumps so the route surface is intentionally
 * small and the destination is a single fixed host directory.
 */
@Controller({ path: 'backups', version: '1' })
export class BackupsController {
  constructor(private readonly backups: BackupsService) {}

  // ----- configs ---------------------------------------------------

  @Get('configs')
  @RequirePermission('backup.manage')
  async listConfigs(): Promise<BackupConfig[]> {
    return this.backups.listConfigs();
  }

  @Get('configs/:id')
  @RequirePermission('backup.manage')
  async getConfig(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BackupConfig> {
    return this.backups.getConfigById(id);
  }

  @Post('configs')
  @RequirePermission('backup.manage')
  @RequireStepUp()
  async createConfig(
    @CurrentUser() actor: AuthedUser,
    @Body(new ZodBody(backupConfigInputSchema)) dto: BackupConfigInput,
    @Req() req: Request,
  ): Promise<BackupConfig> {
    return this.backups.createConfig(actor, dto, requestMetaOf(req));
  }

  @Patch('configs/:id')
  @RequirePermission('backup.manage')
  @RequireStepUp()
  async updateConfig(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(backupConfigPatchSchema)) dto: BackupConfigPatch,
    @Req() req: Request,
  ): Promise<BackupConfig> {
    return this.backups.updateConfig(actor, id, dto, requestMetaOf(req));
  }

  @Delete('configs/:id')
  @RequirePermission('backup.manage')
  @RequireStepUp()
  async deleteConfig(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<{ ok: true }> {
    return this.backups.deleteConfig(actor, id, requestMetaOf(req));
  }

  /**
   * Trigger an immediate run for an existing schedule. Throttled so a
   * stolen session can't enqueue an unbounded number of dumps.
   */
  @Post('configs/:id/run-now')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { limit: 5, ttl: 60_000 } })
  @RequirePermission('backup.manage')
  @RequireStepUp()
  async runNow(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<BackupRunDto> {
    return this.backups.runNow(actor, id, requestMetaOf(req));
  }

  // ----- runs ------------------------------------------------------

  @Get('runs')
  @RequirePermission('backup.manage')
  async listRuns(
    @Query() query: Record<string, unknown>,
  ): Promise<BackupRunDto[]> {
    const { limit, configId } = listRunsQuerySchema.parse(query);
    return this.backups.listRuns({ limit, configId });
  }

  @Get('runs/:id')
  @RequirePermission('backup.manage')
  async getRun(
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<BackupRunDto> {
    return this.backups.getRunById(id);
  }

  /**
   * Stream a completed dump back through the API. The api container
   * has the backup directory bind-mounted read-only, so even with
   * this endpoint the api process cannot tamper with the worker's
   * output.
   */
  @Get('runs/:id/download')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ global: { limit: 10, ttl: 60_000 } })
  @RequirePermission('backup.manage')
  @RequireStepUp()
  async download(
    @CurrentUser() actor: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const file = await this.backups.openRunDump(id);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', file.contentLength.toString());
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename}"`,
    );
    await this.backups.noteDownload(actor, id, requestMetaOf(req));
    return new StreamableFile(file.body);
  }
}
