import { Module } from '@nestjs/common';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { SetupTokenService } from './setup-token.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService, SetupTokenService],
  exports: [UsersService, SetupTokenService],
})
export class UsersModule {}
