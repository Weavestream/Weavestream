import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { MfaService } from './mfa.service.js';
import { MfaBackupCodeService } from './mfa-backup-code.service.js';
import { LockoutService } from './lockout.service.js';
import { PasswordService } from './password.service.js';
import { CsrfService } from './csrf.service.js';
import { StepUpService } from './step-up/step-up.service.js';
import { StepUpController } from './step-up/step-up.controller.js';
import { UsersModule } from '../users/users.module.js';

@Module({
  imports: [UsersModule],
  controllers: [AuthController, StepUpController],
  providers: [
    AuthService,
    TokenService,
    MfaService,
    MfaBackupCodeService,
    LockoutService,
    PasswordService,
    CsrfService,
    StepUpService,
  ],
  exports: [
    AuthService,
    TokenService,
    MfaService,
    MfaBackupCodeService,
    PasswordService,
    CsrfService,
    // Exported so the globally-registered StepUpGuard (app.module) and
    // SecurityService (revoke cleanup) can inject it.
    StepUpService,
    // Exported so MeService can enforce the change-password lockout.
    LockoutService,
  ],
})
export class AuthModule {}
