import { Module } from '@nestjs/common';
import { AiCompletionService } from './ai-completion.service.js';
import { AiSettingsController } from './ai-settings.controller.js';
import { AiSettingsService } from './ai-settings.service.js';
import { AiService } from './ai.service.js';

@Module({
  controllers: [AiSettingsController],
  providers: [AiSettingsService, AiService, AiCompletionService],
  exports: [AiSettingsService, AiService, AiCompletionService],
})
export class AiModule {}
