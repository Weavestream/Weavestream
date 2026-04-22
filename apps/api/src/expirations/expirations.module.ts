import { Module } from '@nestjs/common';
import { ExpirationsService } from './expirations.service.js';
import {
  CompanyExpirationsController,
  GlobalExpirationsController,
} from './expirations.controller.js';

/**
 * ExpirationsModule — read-only aggregator surface for the
 * "Expiring soon" page. Composes existing Prisma models (AssetField,
 * AssetFieldValue, MonitoredDomain) behind a single service, and
 * exposes two REST endpoints: a company-scoped one for the company
 * sidebar entry point, and a cross-company one for the global admin
 * shell's entry point.
 */
@Module({
  controllers: [CompanyExpirationsController, GlobalExpirationsController],
  providers: [ExpirationsService],
  exports: [ExpirationsService],
})
export class ExpirationsModule {}
