import { Global, Module } from '@nestjs/common';
import { SecretEncryptionService } from './secret-encryption.service.js';

/**
 * Global crypto primitives shared across feature modules. Currently
 * exposes `SecretEncryptionService` for the password vault; keep
 * additions here narrow — this module is `@Global()` on purpose so
 * feature modules don't need to import it individually.
 */
@Global()
@Module({
  providers: [SecretEncryptionService],
  exports: [SecretEncryptionService],
})
export class CryptoModule {}
