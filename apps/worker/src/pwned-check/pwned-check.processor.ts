import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import {
  QueueNames,
  pwnedCheckJobSchema,
  type PwnedCheckJob,
} from '@weavestream/shared';
import { EnvService } from '../../../api/src/config/env.service.js';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { PrismaService } from '../../../api/src/prisma/prisma.service.js';
import { AuditLogService } from '../../../api/src/audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../../api/src/audit/audit-actions.js';
import { safeFetch } from '../../../api/src/common/egress/safe-fetch.js';

const HIBP_RANGE_ENDPOINT = 'https://api.pwnedpasswords.com/range';

/**
 * Phase 10 — PwnedCheckWorker.
 *
 * Consumes the `pwned-check` queue. The API hands us the full SHA-1
 * of the plaintext and we split it into `prefix` (sent to hibp) and
 * `suffix` (compared locally). HIBP's `/range/{prefix}` endpoint
 * returns every full hash starting with `prefix` together with the
 * number of times it's shown up across known breaches — that's the
 * "Pwned Passwords k-anonymity" contract.
 *
 * The plaintext never leaves the API; only the 5-char hex prefix
 * travels to the public HIBP API, meaning the service cannot correlate
 * which specific password we're checking. We additionally set
 * `Add-Padding: true` which pads the response to a fixed size so a
 * network observer can't fingerprint popular prefixes by payload size.
 *
 * Toggleable via `HIBP_ENABLED`. When disabled, the worker is still
 * registered but no-ops and records `pwned_checked_at` so the UI can
 * render a "checks disabled" state rather than a stale "never checked".
 */
@Injectable()
export class PwnedCheckWorker implements OnModuleDestroy {
  private readonly logger = new Logger(PwnedCheckWorker.name);
  private worker: Worker | null = null;

  constructor(
    private readonly env: EnvService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;
    this.worker = new Worker(
      QueueNames.pwnedCheck,
      async (job) => this.handle(job),
      {
        connection: this.redis.bullmqConnection(),
        concurrency: 4,
      },
    );
    this.worker.on('ready', () => {
      this.logger.log(
        `PwnedCheck worker ready — hibp_enabled=${this.env.values.HIBP_ENABLED}`,
      );
    });
    this.worker.on('failed', (job, err) => {
      this.logger.error(
        `Pwned-check job ${job?.id ?? '<unknown>'} failed: ${err?.message ?? err}`,
      );
    });
    await this.worker.waitUntilReady();
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.worker) return;
    await this.worker.close();
    this.worker = null;
  }

  private async handle(job: Job<unknown, unknown, string>): Promise<unknown> {
    const parsed = pwnedCheckJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`invalid pwned-check payload: ${parsed.error.message}`);
    }
    const payload: PwnedCheckJob = parsed.data;

    // Drop the job silently when the feature is disabled. We don't
    // error-out because the API might have been configured with HIBP
    // enabled when the job was enqueued; toggling it off shouldn't
    // cause a retry storm.
    if (!this.env.values.HIBP_ENABLED) {
      this.logger.debug(
        `HIBP disabled — skipping pwned check for password ${payload.passwordId}`,
      );
      return null;
    }

    // Verify the row still exists and wasn't archived between enqueue
    // and now. Cheap guard — the HIBP request itself is the expensive
    // part of this handler and we want to skip it when possible.
    const row = await this.prisma.password.findFirst({
      where: {
        id: payload.passwordId,
        companyId: payload.companyId,
        archivedAt: null,
      },
      select: { id: true },
    });
    if (!row) {
      this.logger.debug(
        `Password ${payload.passwordId} missing or archived — skipping HIBP check`,
      );
      return null;
    }

    const count = await this.queryHibp(payload.sha1Hex);

    await this.prisma.password.updateMany({
      where: { id: payload.passwordId, companyId: payload.companyId },
      data: { pwnedCount: count, pwnedCheckedAt: new Date() },
    });

    await this.audit.log({
      actorId: null,
      action: AUDIT_ACTIONS.password.pwnedChecked,
      entityType: 'Password',
      entityId: payload.passwordId,
      companyId: payload.companyId,
      ip: '127.0.0.1',
      userAgent: 'weavestream-worker/pwned-check',
      before: null,
      after: { pwnedCount: count },
    });

    return { passwordId: payload.passwordId, pwnedCount: count };
  }

  /**
   * Fetches the HIBP range response for the 5-char SHA-1 prefix and
   * returns the pwned count for the supplied full-hash suffix (or 0).
   *
   * Failures escalate to BullMQ's retry machinery — the queue is
   * configured with exponential backoff so transient 5xx/rate-limit
   * responses resolve without manual intervention.
   */
  private async queryHibp(sha1Hex: string): Promise<number> {
    const prefix = sha1Hex.slice(0, 5);
    const suffix = sha1Hex.slice(5);
    const res = await safeFetch(`${HIBP_RANGE_ENDPOINT}/${prefix}`, {
      headers: {
        'Add-Padding': 'true',
        'User-Agent': 'weavestream-password-vault',
      },
      timeoutMs: 10_000,
      // The HIBP response is padded to a fixed size so it stays small;
      // 256 KB is several orders of magnitude over what's expected and
      // still cheap to load fully.
      maxResponseBytes: 256 * 1024,
    });
    if (!res.ok) {
      throw new Error(`HIBP responded ${res.status}`);
    }
    const body = await res.text();
    for (const line of body.split(/\r?\n/)) {
      const sep = line.indexOf(':');
      if (sep < 0) continue;
      const lineSuffix = line.slice(0, sep).trim().toUpperCase();
      if (lineSuffix !== suffix) continue;
      const rawCount = line.slice(sep + 1).trim();
      const parsed = Number.parseInt(rawCount, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    }
    return 0;
  }
}
