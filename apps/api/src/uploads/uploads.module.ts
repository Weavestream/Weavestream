import { Module } from '@nestjs/common';
import { PhotosController, UploadsController } from './uploads.controller.js';
import { UploadsService } from './uploads.service.js';

@Module({
  controllers: [UploadsController, PhotosController],
  providers: [UploadsService],
  exports: [UploadsService],
})
export class UploadsModule {}
