import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { SsoConfigModule } from './sso-config.module.js';
import { SsoController } from './sso.controller.js';
import { SsoOidcService } from './sso-oidc.service.js';
import { SsoSettingsController } from './sso-settings.controller.js';
import { SsoSettingsService } from './sso-settings.service.js';
import { SsoService } from './sso.service.js';

/**
 * OIDC single sign-on. Configured by `SSO_*` environment variables, else from Admin > Settings > Single sign-on (see `SsoConfigService`). Sessions are
 * issued through `AuthService.issueSession`, so SSO and password sign-in
 * share one session, refresh and cookie path.
 */
@Module({
  imports: [AuthModule, SsoConfigModule],
  controllers: [SsoController, SsoSettingsController],
  providers: [SsoService, SsoOidcService, SsoSettingsService],
})
export class SsoModule {}
