/**
 * Supported API surface for `apps/worker`: the shared infrastructure every
 * processor builds on — configuration, Prisma, Redis, audit, storage,
 * encryption, email, outbound HTTP, and the queue producer.
 *
 * `public/` means "the package surface other apps may import", not
 * unauthenticated routes. Every file in this directory is an entry point for
 * the worker, published as `@weavestream/api/<file>` through the `exports`
 * map in `apps/api/package.json` — a new file needs an entry there too.
 * Nothing here may export a controller, an HTTP guard, a bootstrap entry, or
 * an API composition module (`AppModule`): those belong to the HTTP process
 * only.
 *
 * Add an export here only when the worker needs it, and keep the domain
 * entries (`domains.ts`, `integrations.ts`, …) for domain code.
 */
export { ConfigModule } from '../config/config.module.js';
export { EnvService } from '../config/env.service.js';
export { PrismaModule } from '../prisma/prisma.module.js';
export { PrismaService } from '../prisma/prisma.service.js';
export { RedisModule } from '../redis/redis.module.js';
export { RedisService } from '../redis/redis.service.js';
export { AuditModule } from '../audit/audit.module.js';
export { AuditLogService } from '../audit/audit.service.js';
export { AUDIT_ACTIONS } from '../audit/audit-actions.js';
export { StorageModule } from '../storage/storage.module.js';
export { LocalStorageService } from '../storage/local-storage.service.js';
export { CryptoModule } from '../crypto/crypto.module.js';
// Provides PermissionService, which AssetsController (reached through the
// integration asset writers) needs even though the worker never serves it.
export { RbacModule } from '../rbac/rbac.module.js';
export {
  SecretEncryptionService,
  exportPdfPasswordAad,
} from '../crypto/secret-encryption.service.js';
export { EmailModule } from '../email/email.module.js';
export { EmailService } from '../email/email.service.js';
export { configureEgressGuard, safeFetch } from '../common/egress/safe-fetch.js';
export { QueuesProducerModule } from '../queues/queues-producer.module.js';
export { QueuesService } from '../queues/queues.service.js';
