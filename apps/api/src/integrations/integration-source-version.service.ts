import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EnvService } from '../config/env.service.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationDriverRegistry } from './drivers/integration-driver.registry.js';
import type { DriverSourceVersion, IntegrationContext } from './drivers/integration-driver.js';
import { sourceVersionLabel } from './source-version.js';

/** Per-request timeout of the version read; one try, no retries. */
export const SOURCE_VERSION_REQUEST_TIMEOUT_MS = 5_000;
/** Hard stop for the whole read, whatever the driver does. */
export const SOURCE_VERSION_DEADLINE_MS = 8_000;

/**
 * Early warning (integration robustness, rule 5): save the version the
 * source reports (for Breeze, the server release and the partner API
 * schema version) on each sync run, so an operator can see when the source
 * changed between two runs.
 *
 * The worker calls this after the run has fanned out its jobs, so the read
 * never delays the sync. It is a tolerant consumer: a driver without a
 * version read, an unreachable source, a slow source, or a value that is
 * not a plain version label all leave the columns null. It never throws.
 */
@Injectable()
export class IntegrationSourceVersionService {
  private readonly logger = new Logger(IntegrationSourceVersionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
    private readonly integrations: IntegrationsService,
    private readonly drivers: IntegrationDriverRegistry,
  ) {}

  async recordForRun(runId: string): Promise<void> {
    try {
      const run = await this.prisma.integrationSyncRun.findUnique({
        where: { id: runId },
        select: { id: true, integrationId: true, integration: { select: { driver: true } } },
      });
      if (!run || !this.drivers.has(run.integration.driver)) return;
      const driver = this.drivers.get(run.integration.driver);
      if (!driver.readSourceVersion) return;
      const loaded = await this.integrations.loadDriverContext(run.integrationId);
      const ctx: IntegrationContext = {
        config: loaded.config,
        secret: loaded.secret,
        oauthClient: loaded.oauthClient,
        connectionId: loaded.connectionId,
        credentialVersion: loaded.credentialVersion,
        integrationId: loaded.integrationId,
        http: {
          timeoutMs: Math.min(
            this.env.values.INTEGRATION_HTTP_TIMEOUT_MS,
            SOURCE_VERSION_REQUEST_TIMEOUT_MS,
          ),
          maxRetries: 0,
          backoffMs: 0,
        },
        correlationId: randomUUID(),
      };
      const read = await withDeadline(driver.readSourceVersion(ctx), SOURCE_VERSION_DEADLINE_MS);
      // Sanitized again here: the stored label never depends on the driver.
      const sourceServerVersion = sourceVersionLabel(read?.serverVersion);
      const sourceSchemaVersion = sourceVersionLabel(read?.schemaVersion);
      if (sourceServerVersion === null && sourceSchemaVersion === null) return;
      await this.prisma.integrationSyncRun.updateMany({
        where: { id: run.id, integrationId: run.integrationId },
        data: { sourceServerVersion, sourceSchemaVersion },
      });
    } catch (error) {
      // Advisory only: the sync itself reports a source it cannot reach.
      // The error name only, never its message (it could carry a URL).
      const name = error instanceof Error ? error.name : typeof error;
      this.logger.debug(`Source version not recorded for run ${runId} (${name}).`);
    }
  }
}

/** The read's result, or null when it does not finish in time. */
async function withDeadline(
  read: Promise<DriverSourceVersion>,
  ms: number,
): Promise<DriverSourceVersion | null> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
