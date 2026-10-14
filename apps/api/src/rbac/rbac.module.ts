import { Global, Module } from '@nestjs/common';
import { CacheModule } from '../cache/cache.module.js';
import { PermissionService } from './permission.service.js';
import { ContractorAccessGuard } from './contractor-access.guard.js';

@Global()
@Module({
  // PermissionService reads the membership snapshot through
  // MembershipCacheService. Import its module here rather than relying on
  // the host app: the worker imports RbacModule without AppModule's
  // CacheModule, and failed to boot when this dependency was implicit.
  imports: [CacheModule],
  providers: [PermissionService, ContractorAccessGuard],
  exports: [PermissionService, ContractorAccessGuard],
})
export class RbacModule {}
