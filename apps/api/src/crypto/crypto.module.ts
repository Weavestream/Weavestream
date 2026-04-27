import { Global, Module } from '@nestjs/common';
import { SecretEncryptionService } from './secret-encryption.service.js';
import { IntegrationSecretEncryptionService } from './integration-secret-encryption.service.js';
import { SmtpSecretEncryptionService } from './smtp-secret-encryption.service.js';

/**
 * Global crypto primitives shared across feature modules.
 *  - `SecretEncryptionService`              — password vault.
 *  - `IntegrationSecretEncryptionService`   — Phase 11 integrations.
 *  - `SmtpSecretEncryptionService`          — global SMTP credentials.
 *
 * `@Global()` on purpose so feature modules don't need to import it
 * individually.
 */
@Global()
@Module({
  providers: [
    SecretEncryptionService,
    IntegrationSecretEncryptionService,
    SmtpSecretEncryptionService,
  ],
  exports: [
    SecretEncryptionService,
    IntegrationSecretEncryptionService,
    SmtpSecretEncryptionService,
  ],
})
export class CryptoModule {}
