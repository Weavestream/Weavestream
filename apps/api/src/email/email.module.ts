import { Module } from '@nestjs/common';
import { EmailSettingsController } from './email-settings.controller.js';
import { EmailSettingsService } from './email-settings.service.js';
import { EmailService } from './email.service.js';

@Module({
  controllers: [EmailSettingsController],
  providers: [EmailSettingsService, EmailService],
  exports: [EmailSettingsService, EmailService],
})
export class EmailModule {}
