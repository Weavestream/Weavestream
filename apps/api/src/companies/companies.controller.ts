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
  createCompanySchema,
  updateCompanySchema,
  type CreateCompanyInput,
  type UpdateCompanyInput,
} from '@weavestream/shared';
import { CompaniesService } from './companies.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';

@Controller({ path: 'companies', version: '1' })
export class CompaniesController {
  constructor(private readonly companies: CompaniesService) {}

  @Get()
  @RequirePermission('company.manage')
  async list(
    @CurrentUser() user: AuthedUser,
    @Query('q') q?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    // Phase 9a: comma-separated UUIDs. Used by the parent-company
    // typeahead to exclude the current company from results.
    @Query('excludeIds') excludeIds?: string,
    // Phase 9b.3: operator-home "Recent companies" hits
    // `?sort=updatedAt&order=desc&limit=6`. Any unknown `sort` value
    // silently falls back to the default alphabetical ordering.
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.companies.list(user, {
      q,
      includeArchived: includeArchived === 'true',
      limit: limit ? parseInt(limit, 10) : undefined,
      cursor,
      excludeIds: excludeIds
        ? excludeIds
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : undefined,
      sort: sort === 'updatedAt' ? 'updatedAt' : undefined,
      order: order === 'asc' ? 'asc' : order === 'desc' ? 'desc' : undefined,
    });
  }

  @Get(':id')
  @RequirePermission('company.manage')
  async get(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.companies.get(user, id);
  }

  @Post()
  @RequirePermission('company.manage')
  async create(
    @CurrentUser() user: AuthedUser,
    @Body(new ZodBody(createCompanySchema)) dto: CreateCompanyInput,
    @Req() req: Request,
  ) {
    return this.companies.create(user, dto, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
  }

  @Patch(':id')
  @RequirePermission('company.manage')
  async update(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateCompanySchema)) dto: UpdateCompanyInput,
    @Req() req: Request,
  ) {
    return this.companies.update(user, id, dto, {
      ip: ipOf(req),
      userAgent: uaOf(req),
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company.manage')
  async archive(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.companies.archive(user, id, { ip: ipOf(req), userAgent: uaOf(req) });
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('company.manage')
  async restore(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.companies.restore(user, id, { ip: ipOf(req), userAgent: uaOf(req) });
  }
}

function ipOf(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.ip ?? '0.0.0.0';
}
function uaOf(req: Request): string {
  return (req.headers['user-agent'] ?? 'unknown').toString().slice(0, 500);
}
