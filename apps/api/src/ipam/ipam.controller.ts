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
  createSubnetSchema,
  updateSubnetSchema,
  createIpReservationSchema,
  updateIpReservationSchema,
  type CreateSubnetInput,
  type UpdateSubnetInput,
  type CreateIpReservationInput,
  type UpdateIpReservationInput,
} from '@weavestream/shared';
import { IpamService } from './ipam.service.js';
import { CurrentUser, type AuthedUser } from '../common/current-user.decorator.js';
import { RequirePermission } from '../rbac/require-permission.decorator.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import { requestMetaOf as meta } from '../common/request-meta.js';

@Controller({ path: 'companies/:companyId/ipam/subnets', version: '1' })
export class IpamController {
  constructor(private readonly ipam: IpamService) {}

  // ------------------------------------------------------------------
  // Subnets
  // ------------------------------------------------------------------

  @Get()
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async listSubnets(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query('q') q?: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    return this.ipam.listSubnetsWithUtilization(actor, companyId, {
      q,
      includeArchived: includeArchived === 'true',
    });
  }

  @Get(':id')
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async getSubnet(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.ipam.getSubnetDetail(actor, companyId, id);
  }

  @Post()
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async createSubnet(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodBody(createSubnetSchema)) dto: CreateSubnetInput,
    @Req() req: Request,
  ) {
    return this.ipam.createSubnet(actor, companyId, dto, meta(req));
  }

  @Patch(':id')
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async updateSubnet(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(updateSubnetSchema)) dto: UpdateSubnetInput,
    @Req() req: Request,
  ) {
    return this.ipam.updateSubnet(actor, companyId, id, dto, meta(req));
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async archiveSubnet(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.ipam.archiveSubnet(actor, companyId, id, meta(req));
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async restoreSubnet(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ) {
    return this.ipam.restoreSubnet(actor, companyId, id, meta(req));
  }

  // ------------------------------------------------------------------
  // Reservations
  // ------------------------------------------------------------------

  @Get(':id/reservations')
  @RequirePermission('asset.read', { companyIdFrom: 'params.companyId' })
  async listReservations(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) subnetId: string,
  ) {
    await this.ipam.getSubnetById(actor, companyId, subnetId);
    return this.ipam.getSubnetDetail(actor, companyId, subnetId).then((d) => d.reservations);
  }

  @Post(':id/reservations')
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async createReservation(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) subnetId: string,
    @Body(new ZodBody(createIpReservationSchema)) dto: CreateIpReservationInput,
    @Req() req: Request,
  ) {
    return this.ipam.createReservation(actor, companyId, subnetId, dto, meta(req));
  }

  @Patch(':id/reservations/:reservationId')
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async updateReservation(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) subnetId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Body(new ZodBody(updateIpReservationSchema)) dto: UpdateIpReservationInput,
    @Req() req: Request,
  ) {
    return this.ipam.updateReservation(
      actor,
      companyId,
      subnetId,
      reservationId,
      dto,
      meta(req),
    );
  }

  @Delete(':id/reservations/:reservationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission('asset.write', { companyIdFrom: 'params.companyId' })
  async deleteReservation(
    @CurrentUser() actor: AuthedUser,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) subnetId: string,
    @Param('reservationId', new ParseUUIDPipe()) reservationId: string,
    @Req() req: Request,
  ) {
    await this.ipam.deleteReservation(
      actor,
      companyId,
      subnetId,
      reservationId,
      meta(req),
    );
  }
}

