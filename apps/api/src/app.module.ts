import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConfigModule } from './config/config.module.js';
import { EnvService } from './config/env.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RedisModule } from './redis/redis.module.js';
import { RedisService } from './redis/redis.service.js';
import { AuditModule } from './audit/audit.module.js';
import { AuditController } from './audit/audit.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { CacheModule } from './cache/cache.module.js';
import { RbacModule } from './rbac/rbac.module.js';
import { CompaniesModule } from './companies/companies.module.js';
import { UsersModule } from './users/users.module.js';
import { MembershipsModule } from './memberships/memberships.module.js';
import { MeModule } from './me/me.module.js';
import { StarsModule } from './stars/stars.module.js';
import { ActivityModule } from './activity/activity.module.js';
import { FieldTypesModule } from './field-types/field-types.module.js';
import { AssetLayoutsModule } from './asset-layouts/asset-layouts.module.js';
import { AssetsModule } from './assets/assets.module.js';
import { RelationsModule } from './relations/relations.module.js';
import { StorageModule } from './storage/storage.module.js';
import { UploadsModule } from './uploads/uploads.module.js';
import { FoldersModule } from './folders/folders.module.js';
import { ArticlesModule } from './articles/articles.module.js';
import { SearchModule } from './search/search.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { DomainsModule } from './domains/domains.module.js';
import {
  DomainsAlertsController,
  DomainsController,
} from './domains/domains.controller.js';
import { PasswordsModule } from './passwords/passwords.module.js';
import {
  PasswordFoldersController,
  PasswordsController,
} from './passwords/passwords.controller.js';
import { ExpirationsModule } from './expirations/expirations.module.js';
import { UiModule } from './ui/ui.module.js';
import { CryptoModule } from './crypto/crypto.module.js';
import { AuthGuard } from './auth/guards/auth.guard.js';
import { MfaEnrollmentGuard } from './auth/guards/mfa-enrollment.guard.js';
import { CsrfGuard } from './auth/guards/csrf.guard.js';
import { PermissionGuard } from './rbac/permission.guard.js';
import { ContractorAccessGuard } from './rbac/contractor-access.guard.js';
import { TenantContextInterceptor } from './auth/interceptors/tenant-context.interceptor.js';
import { AuditInterceptor } from './audit/audit.interceptor.js';
import { ProblemExceptionFilter } from './common/problem-exception.filter.js';
import { RedisThrottlerStorage } from './redis/redis-throttler.storage.js';

/** Compact access logs: avoid logging full req/res headers on every line. */
const httpSerializers = {
  req: (req: IncomingMessage) => {
    const id = (req as IncomingMessage & { id?: string }).id;
    return { id, method: req.method, url: req.url };
  },
  res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
};

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [EnvService],
      useFactory: (env: EnvService) => ({
        pinoHttp: {
          level: env.values.LOG_LEVEL,
          serializers: httpSerializers,
          genReqId: (req) =>
            (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
          customProps: (req) => ({ requestId: (req as { id?: string }).id }),
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'res.headers["set-cookie"]',
              'password',
              'password_hash',
              'mfa_secret',
              'mfa_secret_encrypted',
              'csrf_token',
            ],
            censor: '[REDACTED]',
          },
          transport:
            env.values.NODE_ENV === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule, RedisModule],
      inject: [EnvService, RedisService],
      useFactory: (env: EnvService, redis: RedisService) => ({
        throttlers: [
          {
            name: 'global',
            ttl: 60_000,
            limit: env.values.GLOBAL_RATE_LIMIT_PER_MIN,
          },
        ],
        storage: new RedisThrottlerStorage(redis.client),
      }),
    }),
    RedisModule,
    PrismaModule,
    CacheModule,
    CryptoModule,
    AuditModule,
    RbacModule,
    AuthModule,
    CompaniesModule,
    UsersModule,
    MembershipsModule,
    MeModule,
    StarsModule,
    ActivityModule,
    FieldTypesModule,
    AssetLayoutsModule,
    AssetsModule,
    RelationsModule,
    StorageModule,
    UploadsModule,
    FoldersModule,
    ArticlesModule,
    SearchModule,
    SettingsModule,
    QueuesModule,
    DomainsModule,
    PasswordsModule,
    ExpirationsModule,
    UiModule,
    HealthModule,
  ],
  controllers: [
    AuditController,
    DomainsController,
    DomainsAlertsController,
    PasswordsController,
    PasswordFoldersController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: MfaEnrollmentGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_GUARD, useClass: ContractorAccessGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: ProblemExceptionFilter },
  ],
})
export class AppModule {}
