import { Module } from '@nestjs/common';
import { RelationsController } from './relations.controller.js';
import { RelationsService } from './relations.service.js';

/**
 * Phase 3 scaffolded this as a service-only module consumed by
 * AssetsModule for ASSET_REFERENCE auto-sync. Phase 5 adds the HTTP
 * surface (`RelationsController`) so the Linked-Items panel on asset
 * and article detail pages can read / create / delete rows.
 */
@Module({
  controllers: [RelationsController],
  providers: [RelationsService],
  exports: [RelationsService],
})
export class RelationsModule {}
