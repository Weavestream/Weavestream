import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { IntegrationSyncSchedulerService } from './integration-sync-scheduler.service.js';

/**
 * Phase 11 — boot-time entry point for Integration sync schedules.
 *
 * Delegates to `IntegrationSyncSchedulerService.refreshAll()` which
 * clears every `scheduled-*` repeatable across the orchestrator and
 * cloudflare drift-sweep queues and re-registers one per ACTIVE
 * integration.
 *
 * Why on API boot rather than the worker:
 *   - Repeatable registrations are managed via `add(... { repeat: …,
 *     jobId })`, which is idempotent only when the same `jobId` is
 *     reused. Concentrating that ownership on the API side gives the
 *     operator a single deploy target to flip the schedule.
 *   - The worker doesn't watch Postgres for new Integrations — the
 *     API is the only place creates/updates flow through.
 *
 * Mid-cycle CRUD calls `IntegrationSyncSchedulerService.refreshFor`
 * directly from `IntegrationsService` so an operator doesn't have to
 * wait for the next API restart to see their schedule pick up.
 */
@Injectable()
export class IntegrationSyncQueueRegistrar implements OnApplicationBootstrap {
  constructor(private readonly scheduler: IntegrationSyncSchedulerService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.scheduler.refreshAll();
  }
}
