import { Global, Module } from '@nestjs/common';
import { PermissionService } from './permission.service.js';
import { ContractorAccessGuard } from './contractor-access.guard.js';

@Global()
@Module({
  providers: [PermissionService, ContractorAccessGuard],
  exports: [PermissionService, ContractorAccessGuard],
})
export class RbacModule {}
