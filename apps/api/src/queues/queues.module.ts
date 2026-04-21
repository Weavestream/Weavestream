import { Global, Module } from '@nestjs/common';
import { QueuesService } from './queues.service.js';
import { DomainChecksQueueRegistrar } from './domain-checks-queue.registrar.js';

/**
 * Phase 8 — BullMQ producer module.
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
 */
@Global()
@Module({
  providers: [QueuesService, DomainChecksQueueRegistrar],
  exports: [QueuesService],
})
export class QueuesModule {}
