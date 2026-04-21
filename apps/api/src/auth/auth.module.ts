import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { MfaService } from './mfa.service.js';
import { LockoutService } from './lockout.service.js';
import { PasswordService } from './password.service.js';
import { CsrfService } from './csrf.service.js';
import { UsersModule } from '../users/users.module.js';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    MfaService,
    LockoutService,
    PasswordService,
    CsrfService,
  ],
  exports: [AuthService, TokenService, MfaService, PasswordService, CsrfService],
})
export class AuthModule {}
