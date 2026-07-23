import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { IdentityRetargetDrainService } from './identity-retarget-drain.service.js';

@Global()
@Module({
  // IdentityRetargetDrainService rides this module deliberately: the
  // worker app imports PrismaModule too, so both processes drain the
  // 0062 helper table (api first — it boots right after `migrate
  // deploy` — the new worker as backstop).
  providers: [PrismaService, IdentityRetargetDrainService],
  exports: [PrismaService],
})
export class PrismaModule {}
