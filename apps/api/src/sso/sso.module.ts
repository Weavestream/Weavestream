import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SsoConfigModule } from './sso-config.module.js';
import { SsoController } from './sso.controller.js';
import { SsoOidcService } from './sso-oidc.service.js';
import { SsoService } from './sso.service.js';

/**
 * OIDC single sign-on, configured by `SSO_*` environment variables (see
 * `SsoConfigService`). Sessions are issued through `AuthService.issueSession`,
 * so SSO and password sign-in share one session, refresh and cookie path.
 */
@Module({
  imports: [AuthModule, SsoConfigModule],
  controllers: [SsoController],
  providers: [SsoService, SsoOidcService],
})
export class SsoModule {}
