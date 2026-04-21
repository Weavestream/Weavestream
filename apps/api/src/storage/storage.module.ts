import { Global, Module } from '@nestjs/common';
import { MinioService } from './minio.service.js';

@Global()
@Module({
  providers: [MinioService],
  exports: [MinioService],
})
export class StorageModule {}
