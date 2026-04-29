import { Module } from '@nestjs/common';
import { IpamService } from './ipam.service.js';

@Module({
  providers: [IpamService],
  exports: [IpamService],
})
export class IpamModule {}
