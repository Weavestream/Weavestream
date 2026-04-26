import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { ExportsService } from './exports.service.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody, ZodParam } from '../common/zod-validation.pipe.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';

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
