import { Module } from '@nestjs/common';
import { AdminStatsController } from './admin-stats.controller.js';
import { AdminStatsService } from './admin-stats.service.js';

/**
 * AdminModule — small read-only aggregator surfaces for the global
 * admin dashboard. Currently hosts `/admin/stats`; the module exists
 * as a stable home for future dashboard-only helpers that don't
 * belong inside a feature-specific module.
 */
@Module({
  controllers: [AdminStatsController],
  providers: [AdminStatsService],
})
export class AdminModule {}
