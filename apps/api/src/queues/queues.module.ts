import { Global, Module } from '@nestjs/common';
import { QueuesProducerModule } from './queues-producer.module.js';
import { DomainChecksQueueRegistrar } from './domain-checks-queue.registrar.js';
import { UploadReaperQueueRegistrar } from './upload-reaper-queue.registrar.js';

/**
 * Phase 8 — BullMQ producer module (API-side).
 *
 * Exposed globally because the DomainsService (for manual "Check now")
 * and the CLI (for `check-domains`) both enqueue into the same
 * `domain-checks` queue. Consumers live in `apps/worker`; this module
 * holds only the producer + bootstrap registrations.
 *
 * The `DomainChecksQueueRegistrar` is responsible for adding the
 * repeatable job on API boot so an operator never has to call a
 * "register scheduled job" endpoint — the system converges by itself
 * to the cron configured in `DOMAIN_CHECK_CRON`. Setting the env var
 * to the literal string "off" disables the registration, which is
 * useful for local development and CI.
 *
 * The actual `QueuesService` provider lives in `QueuesProducerModule`
 * so the worker can wire the producer without also re-running the
 * API-only registrar.
 */
@Global()
@Module({
  imports: [QueuesProducerModule],
  providers: [DomainChecksQueueRegistrar, UploadReaperQueueRegistrar],
  exports: [QueuesProducerModule],
})
export class QueuesModule {}
