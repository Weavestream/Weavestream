import { Module } from '@nestjs/common';
import { MeService } from './me.service.js';
import { MeController } from './me.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [MeController],
  providers: [MeService],
  exports: [MeService],
})
export class MeModule {}
