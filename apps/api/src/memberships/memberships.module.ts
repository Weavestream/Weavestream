import { Module } from '@nestjs/common';
import { MembershipsService } from './memberships.service.js';
import { MembershipsController } from './memberships.controller.js';
import { MembershipsCompanyController } from './memberships-company.controller.js';

@Module({
  controllers: [MembershipsController, MembershipsCompanyController],
  providers: [MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
