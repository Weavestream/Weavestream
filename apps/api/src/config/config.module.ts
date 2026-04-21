import { Global, Module } from '@nestjs/common';
import { EnvService } from './env.service.js';

@Global()
@Module({
  providers: [EnvService],
  exports: [EnvService],
})
export class ConfigModule {}
