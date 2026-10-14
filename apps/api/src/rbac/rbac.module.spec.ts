import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';
import { ContractorAccessGuard } from './contractor-access.guard.js';
import { PermissionService } from './permission.service.js';
import { RbacModule } from './rbac.module.js';

/**
 * Stands in for the global infrastructure modules (PrismaModule,
 * RedisModule) that every host app imports. Nothing else is provided, so
 * any other dependency RbacModule needs must come from its own imports.
 */
@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: {} },
    { provide: RedisService, useValue: {} },
  ],
  exports: [PrismaService, RedisService],
})
class StubInfrastructureModule {}

describe('RbacModule', () => {
  // Regression for issue #71: the worker imports RbacModule without
  // AppModule's CacheModule, and PermissionService failed to resolve
  // MembershipCacheService on boot.
  it('resolves its providers without the host app importing CacheModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StubInfrastructureModule, RbacModule],
    }).compile();

    expect(moduleRef.get(PermissionService)).toBeInstanceOf(PermissionService);
    expect(moduleRef.get(ContractorAccessGuard)).toBeInstanceOf(ContractorAccessGuard);
    await moduleRef.close();
  });
});
