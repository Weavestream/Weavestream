import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { ExportsService } from './exports.service.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { RequireStepUp } from '../auth/step-up/require-step-up.decorator.js';
import { ZodBody, ZodParam } from '../common/zod-validation.pipe.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

const triggerExportSchema = z.object({
  includePasswords: z.boolean().default(false),
  pdfPassword: z.string().min(1).max(128).optional(),
});
type TriggerExportInput = z.infer<typeof triggerExportSchema>;

/** BullMQ job ids are short opaque strings (default: numeric counters). */
const jobIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_:-]+$/);

/**
 * Bulk PDF vault export. Restricted to SUPER_ADMIN — see
 * `permissions.ts#export.create`. The trigger endpoint is throttled
 * tightly because every successful call enqueues a heavy worker job
 * that may decrypt every password in a tenant; a stolen session token
 * should hit the rate limiter long before it can scrape the vault.
 */
@Controller({ path: 'export', version: '1' })
export class ExportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post('company/:companyId')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ global: { limit: 5, ttl: 60_000 } })
  @RequirePermission('export.create')
  // Step-up only when the export embeds plaintext passwords — the
  // sensitive case. `req.body` here is the raw JSON (guards run before
  // the Zod pipe), so an omitted flag reads as `undefined`, not the
  // schema default `false` — `=== true` handles both correctly.
  @RequireStepUp({
    when: (req) =>
      (req.body as { includePasswords?: unknown } | undefined)
        ?.includePasswords === true,
  })
  async trigger(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(triggerExportSchema)) dto: TriggerExportInput,
    @Req() req: Request,
  ) {
    return this.exports.triggerExport(actor, companyId, dto, meta(req));
  }

  @Get('job/:jobId')
  @RequirePermission('export.create')
  async status(@Param('jobId', new ZodParam(jobIdSchema)) jobId: string) {
    return this.exports.getJobStatus(jobId);
  }

  /**
   * Stream a completed export PDF back through the API. Same pattern
   * as `/uploads/:id/image` — keeps the browser on a single origin
   * and means deployments only need one reverse-proxy entry. The
   * `attachment` Content-Disposition triggers the save-as dialog so
   * the click acts like a regular download link.
   */
  @Get('job/:jobId/download')
  @Header('Cache-Control', 'private, no-store')
  @RequirePermission('export.create')
  @RequireStepUp()
  async download(
    @Param('jobId', new ZodParam(jobIdSchema)) jobId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const located = await this.exports.resolveCompletedExport(jobId);
    if (!located) {
      throw new NotFoundException({ error: 'ExportUnavailable' });
    }
    const stream = await this.exports.getExportObjectStream(
      located.companyId,
      located.storageKey,
    );
    if (!stream) {
      throw new NotFoundException({ error: 'ExportUnavailable' });
    }
    res.setHeader('Content-Type', stream.contentType ?? 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (typeof stream.contentLength === 'number') {
      res.setHeader('Content-Length', stream.contentLength.toString());
    }
    if (stream.lastModified) {
      res.setHeader('Last-Modified', stream.lastModified.toUTCString());
    }
    if (stream.etag) {
      res.setHeader('ETag', stream.etag);
    }
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="vault-export.pdf"',
    );
    return new StreamableFile(Readable.from(stream.body));
  }
}

