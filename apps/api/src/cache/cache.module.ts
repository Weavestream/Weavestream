import { Global, Module } from '@nestjs/common';
import { MembershipCacheService } from './membership-cache.service.js';

@Global()
@Module({
  providers: [MembershipCacheService],
  exports: [MembershipCacheService],
})
export class CacheModule {}
