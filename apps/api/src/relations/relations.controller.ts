import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createRelationSchema,
  relationEndpointKinds,
  type CreateRelationInput,
  type RelationEndpointKind,
} from '@weavestream/shared';
import {
  MANUAL_RELATION_TYPE,
  RELATION_ENTITY_TYPE,
  RelationsService,
  type ListRelatedResult,
} from './relations.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { AuditLogService } from '../audit/audit.service.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

/**
 * Phase 5 HTTP surface for the polymorphic `Relation` table. Every route
 * is company-scoped via `:companyId`, RBAC-gated via `relation.read` or
 * `relation.write`, and backed by `RelationsService` — which already owns
 * the ASSET_REFERENCE auto-sync path.
 */
@Controller({ path: 'companies/:companyId/relations', version: '1' })
export class RelationsController {
  constructor(
    private readonly relations: RelationsService,
    private readonly audit: AuditLogService,
  ) {}

  @Get()
  @RequirePermission('relation.read', { companyIdFrom: 'params.companyId' })
  async list(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query('entityType') rawEntityType: string | undefined,
    @Query('entityId') rawEntityId: string | undefined,
  ): Promise<ListRelatedResult> {
    if (!rawEntityType || !rawEntityId) {
      throw new BadRequestException({
        error: 'MissingQueryParams',
        message: 'entityType and entityId query params are required.',
      });
    }
    const entityType = relationEndpointKinds.find((k) => k === rawEntityType) as
      | RelationEndpointKind
      | undefined;
    if (!entityType) {
      throw new BadRequestException({
        error: 'InvalidEntityType',
        message: `entityType must be one of: ${relationEndpointKinds.join(', ')}`,
      });
    }
    // ParseUUIDPipe-equivalent for a query arg.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawEntityId)) {
      throw new BadRequestException({
        error: 'InvalidEntityId',
        message: 'entityId must be a UUID.',
      });
    }
    return this.relations.listRelated({
      actor: { id: actor.id, role: actor.role },
      companyId,
      entityType,
      entityId: rawEntityId,
    });
  }

  @Get('labels')
  @RequirePermission('relation.read', { companyIdFrom: 'params.companyId' })
  async labels(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query('q') q?: string,
  ): Promise<{ items: string[] }> {
    const items = await this.relations.listRelationTypes(companyId, q);
    return { items };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission('relation.write', { companyIdFrom: 'params.companyId' })
  async create(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createRelationSchema)) dto: CreateRelationInput,
    @Req() req: Request,
  ) {
    await this.relations.assertEndpointsInCompany({
      companyId,
      sourceType: dto.sourceType,
      sourceId: dto.sourceId,
      targetType: dto.targetType,
      targetId: dto.targetId,
    });
    const relationType = dto.relationType?.trim() || MANUAL_RELATION_TYPE;
    const sourceTypeDb = RELATION_ENTITY_TYPE[dto.sourceType];
    const targetTypeDb = RELATION_ENTITY_TYPE[dto.targetType];

    await this.relations.link({
      companyId,
      sourceType: sourceTypeDb,
      sourceId: dto.sourceId,
      targetType: targetTypeDb,
      targetId: dto.targetId,
      relationType,
      actorId: actor.id,
    });

    const row = await this.relations.findByKey({
      companyId,
      sourceType: sourceTypeDb,
      sourceId: dto.sourceId,
      targetType: targetTypeDb,
      targetId: dto.targetId,
      relationType,
    });
    if (!row) {
      // Should be impossible after a successful link() — defensive.
      throw new NotFoundException('Relation was not persisted.');
    }

    const m = meta(req);
    await this.audit.log({
      actorId: actor.id,
      action: 'relation.create',
      entityType: 'Relation',
      entityId: row.id,
      companyId,
      ip: m.ip,
      userAgent: m.userAgent,
      before: null,
      after: {
        sourceType: sourceTypeDb,
        sourceId: dto.sourceId,
        targetType: targetTypeDb,
        targetId: dto.targetId,
        relationType,
      },
    });

    return { id: row.id };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('relation.write', { companyIdFrom: 'params.companyId' })
  async remove(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    const deleted = await this.relations.deleteById(companyId, id);
    if (!deleted) throw new NotFoundException();

    const m = meta(req);
    await this.audit.log({
      actorId: actor.id,
      action: 'relation.delete',
      entityType: 'Relation',
      entityId: id,
      companyId,
      ip: m.ip,
      userAgent: m.userAgent,
      before: deleted,
      after: null,
    });
    return { ok: true };
  }
}

