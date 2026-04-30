import { Module } from '@nestjs/common';
import { StarsController } from './stars.controller.js';
import { StarsService } from './stars.service.js';

@Module({
  controllers: [StarsController],
  providers: [StarsService],
  exports: [StarsService],
})
export class StarsModule {}
