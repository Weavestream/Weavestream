import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MembershipsService } from './memberships.service.js';
import { MembershipsController } from './memberships.controller.js';
import { MembershipsCompanyController } from './memberships-company.controller.js';

@Module({
  // AuthModule supplies StepUpService for the membership step-up checks.
  imports: [AuthModule],
  controllers: [MembershipsController, MembershipsCompanyController],
  providers: [MembershipsService],
  exports: [MembershipsService],
})
export class MembershipsModule {}
