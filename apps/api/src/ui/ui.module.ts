import { Module } from '@nestjs/common';
import { PublicUiController } from './ui.controller.js';

/**
 * Phase 9b.1 — hosts the unauthenticated `POST /public/ui-prefs`
 * endpoint. Kept in its own module so the surface area is clearly
 * separate from the authenticated MeController.
 */
@Module({
  controllers: [PublicUiController],
})
export class UiModule {}
