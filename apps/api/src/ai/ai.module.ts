import { Module } from '@nestjs/common';
import { AiSettingsController } from './ai-settings.controller.js';
import { AiSettingsService } from './ai-settings.service.js';
import { AiService } from './ai.service.js';

@Module({
  controllers: [AiSettingsController],
  providers: [AiSettingsService, AiService],
  exports: [AiSettingsService, AiService],
})
export class AiModule {}
