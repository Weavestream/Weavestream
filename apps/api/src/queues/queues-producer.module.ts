import { Global, Module } from '@nestjs/common';
import { QueuesService } from './queues.service.js';

/**
 * Phase 11 — minimal BullMQ producer module.
 *
 * Pulled out of `QueuesModule` so processes that need to enqueue
 * jobs but should NOT re-register cron schedules can opt in to
 * `QueuesProducerModule` only. The worker uses this module so the
 * `IntegrationSyncService` can fan out scheduled-run jobs without
 * also booting the API-only `DomainChecksQueueRegistrar`.
 *
 * `QueuesModule` (API-side) imports this module and layers the
 * registrar on top. Both modules are `@Global()` so any consumer
 * that needs `QueuesService` gets it from the first import in the
 * dependency graph.
 */
@Global()
@Module({
  providers: [QueuesService],
  exports: [QueuesService],
})
export class QueuesProducerModule {}
