/**
 * Guards the 1 error class the port to `createManagedWorker` actually risks:
 * a copy-paste that points a processor at the wrong queue or drops its
 * concurrency. Both values are a plain `string` and `number`, so no type check
 * catches it, and a consumer bound to the wrong queue is a production incident.
 *
 * Deliberately shallow. It asserts wiring only, never behavior — the domain
 * specs beside each processor already own that, and none of them calls
 * `start()`.
 */
jest.mock('bullmq', () => {
  const { EventEmitter } = require('node:events') as typeof import('node:events');

  class FakeWorker extends EventEmitter {
    static instances: FakeWorker[] = [];
    waitUntilReady = jest.fn(async () => undefined);
    close = jest.fn(async () => undefined);
    constructor(
      readonly queueName: string,
      readonly handler: unknown,
      readonly opts: Record<string, unknown>,
    ) {
      super();
      FakeWorker.instances.push(this);
    }
  }
  class FakeQueue {
    close = jest.fn(async () => undefined);
  }
  return { __esModule: true, Worker: FakeWorker, Queue: FakeQueue };
});

import { QueueNames } from '@weavestream/shared';
import { Worker } from 'bullmq';
import { AlertsWorker } from '../alerts/alerts.processor.js';
import { ArticleSummaryWorker } from '../article-summary/article-summary.processor.js';
import { BackupWorker } from '../backup/backup.processor.js';
import { CloudflareDriftSweepWorker } from '../cloudflare/cloudflare-drift-sweep.processor.js';
import { CompanyPdfExportWorker } from '../company-pdf-export/company-pdf-export.processor.js';
import { DomainChecksWorker } from '../domain-checks/domain-checks.processor.js';
import { IntegrationSyncMappingWorker } from '../integration-sync/integration-sync-mapping.processor.js';
import { IntegrationSyncOrchestratorWorker } from '../integration-sync/integration-sync-orchestrator.processor.js';
import { PwnedCheckWorker } from '../pwned-check/pwned-check.processor.js';
import { UploadReaperWorker } from '../uploads/upload-reaper.processor.js';

const FakeWorker = Worker as unknown as {
  instances: Array<{ queueName: string; opts: Record<string, unknown> }>;
};

/** Only the values `start()` reads. Everything else is untouched by wiring. */
const env = {
  values: {
    DOMAIN_CHECK_CONCURRENCY: 5,
    INTEGRATION_SYNC_MAPPING_CONCURRENCY: 6,
    INTEGRATION_SYNC_ORCHESTRATOR_CONCURRENCY: 7,
    BACKUP_JOB_LOCK_MINUTES: 360,
    BACKUP_STORAGE_DIR: '/var/lib/weavestream/backup',
    HIBP_ENABLED: true,
  },
} as never;

const redis = { bullmqConnection: () => ({}) } as never;
const stub = {} as never;

interface Case {
  readonly name: string;
  readonly queue: string;
  readonly concurrency: number;
  readonly make: () => { start(): Promise<void>; onModuleDestroy(): Promise<void> };
}

const CASES: readonly Case[] = [
  {
    name: 'DomainChecksWorker',
    queue: QueueNames.domainChecks,
    concurrency: 5,
    make: () => new DomainChecksWorker(env, redis, stub, stub),
  },
  {
    name: 'PwnedCheckWorker',
    queue: QueueNames.pwnedCheck,
    concurrency: 4,
    make: () => new PwnedCheckWorker(env, redis, stub, stub),
  },
  {
    name: 'CompanyPdfExportWorker',
    queue: QueueNames.companyExport,
    concurrency: 2,
    make: () => new CompanyPdfExportWorker(redis, stub, stub, stub, stub),
  },
  {
    name: 'IntegrationSyncOrchestratorWorker',
    queue: QueueNames.integrationSyncOrchestrator,
    concurrency: 7,
    make: () => new IntegrationSyncOrchestratorWorker(env, redis, stub, stub),
  },
  {
    name: 'IntegrationSyncMappingWorker',
    queue: QueueNames.integrationSyncMapping,
    concurrency: 6,
    make: () =>
      new IntegrationSyncMappingWorker(env, redis, stub, stub, stub, stub, stub),
  },
  {
    name: 'CloudflareDriftSweepWorker',
    queue: QueueNames.cloudflareDriftSweep,
    concurrency: 2,
    make: () => new CloudflareDriftSweepWorker(env, redis, stub),
  },
  {
    name: 'AlertsWorker',
    queue: QueueNames.alerts,
    concurrency: 2,
    make: () => new AlertsWorker(env, redis, stub, stub, stub, stub),
  },
  {
    name: 'BackupWorker',
    queue: QueueNames.backup,
    concurrency: 1,
    make: () => new BackupWorker(redis, stub, stub, stub, env),
  },
  {
    name: 'UploadReaperWorker',
    queue: QueueNames.uploadReaper,
    concurrency: 1,
    make: () => new UploadReaperWorker(env, redis, stub, stub, stub),
  },
  {
    name: 'ArticleSummaryWorker',
    queue: QueueNames.articleSummary,
    concurrency: 1,
    make: () => new ArticleSummaryWorker(redis, stub, stub, stub, stub),
  },
];

describe('processor queue wiring', () => {
  beforeEach(() => {
    FakeWorker.instances.length = 0;
  });

  it.each(CASES.map((c) => [c.name, c] as const))(
    '%s consumes its own queue at its own concurrency',
    async (_name, testCase) => {
      const processor = testCase.make();
      await processor.start();

      expect(FakeWorker.instances).toHaveLength(1);
      const built = FakeWorker.instances[0]!;
      expect(built.queueName).toBe(testCase.queue);
      expect(built.opts.concurrency).toBe(testCase.concurrency);

      await processor.onModuleDestroy();
    },
  );

  it('covers every queue exactly once, with no duplicates', () => {
    const queues = CASES.map((c) => c.queue);
    expect(new Set(queues).size).toBe(queues.length);
    expect(queues).toHaveLength(10);
  });

  it('keeps the backup lock knobs the helper must pass through', async () => {
    const processor = new BackupWorker(redis, stub, stub, stub, env);
    await processor.start();

    const built = FakeWorker.instances[0]!;
    expect(built.opts.lockDuration).toBe(360 * 60_000);
    expect(built.opts.lockRenewTime).toBe(Math.floor((360 * 60_000) / 6));
    expect(built.opts.stalledInterval).toBe(60_000);

    await processor.onModuleDestroy();
  });
});
