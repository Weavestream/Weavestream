import { Module } from '@nestjs/common';
import { SsoConfigService } from './sso-config.service.js';

/**
 * Single source of truth for SSO configuration. Its own module so the auth
 * guard and `AuthService` (which AuthModule owns) and the SSO feature module
 * (which imports AuthModule) can all inject it without a cycle.
 */
@Module({
  providers: [SsoConfigService],
  exports: [SsoConfigService],
})
export class SsoConfigModule {}
