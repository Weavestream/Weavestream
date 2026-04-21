import { Module } from '@nestjs/common';
import { StarsController } from './stars.controller.js';
import { StarsService } from './stars.service.js';
import { StorageModule } from '../storage/storage.module.js';

@Module({
  imports: [StorageModule],
  controllers: [StarsController],
  providers: [StarsService],
  exports: [StarsService],
})
export class StarsModule {}
