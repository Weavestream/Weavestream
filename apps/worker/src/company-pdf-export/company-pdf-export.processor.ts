import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker, Queue, type Job } from 'bullmq';
import {
  CompanyExportJobNames,
  QueueNames,
  companyExportJobSchema,
  type CompanyExportJob,
  type ExportJobResult,
} from '@weavestream/shared';
import { RedisService } from '../../../api/src/redis/redis.service.js';
import { LocalStorageService } from '../../../api/src/storage/local-storage.service.js';
import {
  SecretEncryptionService,
  exportPdfPasswordAad,
} from '../../../api/src/crypto/secret-encryption.service.js';
import { AuditLogService } from '../../../api/src/audit/audit.service.js';
import { AUDIT_ACTIONS } from '../../../api/src/audit/audit-actions.js';
import {
  CompanyExportDataService,
  type CompanyExportData,
} from '../../../api/src/exports/company-export-data.service.js';
import { buildCompanyExportPdf, pdfEmbedSizeBlockReason } from './pdf-builder.js';

/** 4 hours in milliseconds — how long before the cleanup job fires. */
const CLEANUP_DELAY_MS = 4 * 60 * 60 * 1000;

@Injectable()
export class CompanyPdfExportWorker implements OnModuleDestroy {
  private readonly logger = new Logger(CompanyPdfExportWorker.name);
  private worker: Worker | null = null;

  /**
   * Long-lived producer used to schedule the delayed cleanup job after
   * each successful export. Reusing this single Queue instance avoids
   * the open-connect-add-close churn we'd hit if every export job
   * minted its own client.
   */
  private cleanupProducer: Queue | null = null;

  constructor(
    private readonly redis: RedisService,
    private readonly storage: LocalStorageService,
    private readonly crypto: SecretEncryptionService,
    private readonly audit: AuditLogService,
    private readonly exportData: CompanyExportDataService,
  ) {}

  async start(): Promise<void> {
    if (this.worker) return;

    this.cleanupProducer = new Queue(QueueNames.companyExport, {
      connection: this.redis.bullmqConnection(),
    });

    this.worker = new Worker(
      QueueNames.companyExport,
      async (job: Job) => this.dispatch(job),
      {
        connection: this.redis.bullmqConnection(),
        concurrency: 2,
      },
    );

    this.worker.on('completed', (job) =>
      this.logger.log(`[${job.id}] company-export job completed`),
    );
    this.worker.on('failed', (job, err) =>
      this.logger.error(`[${job?.id}] company-export job failed: ${err.message}`),
    );

    this.logger.log('CompanyPdfExportWorker started');
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.cleanupProducer?.close();
    this.worker = null;
    this.cleanupProducer = null;
  }

  // -------------------------------------------------------------------------

  private async dispatch(job: Job): Promise<ExportJobResult | void> {
    const parsed = companyExportJobSchema.safeParse(job.data);
    if (!parsed.success) {
      throw new Error(`Invalid job payload: ${JSON.stringify(parsed.error.issues)}`);
    }
    const payload = parsed.data;

    if (payload.kind === CompanyExportJobNames.export) {
      return this.handleExport(job, payload);
    }
    if (payload.kind === CompanyExportJobNames.cleanup) {
      await this.handleCleanup(payload);
    }
  }

  private async handleExport(
    job: Job,
    payload: Extract<CompanyExportJob, { kind: 'export' }>,
  ): Promise<ExportJobResult> {
    const { exportId, companyId, includePasswords, pdfPasswordCiphertext } = payload;

    // Decrypt the PDF password right before we hand it to PDFKit so the
    // plaintext lives in this process's memory for the shortest time
    // possible. If decryption fails we fail the whole job — better than
    // silently producing an unencrypted PDF when the operator asked for
    // one.
    let pdfPassword: string | undefined;
    if (pdfPasswordCiphertext) {
      try {
        pdfPassword = this.crypto.decrypt(
          pdfPasswordCiphertext,
          exportPdfPasswordAad(exportId),
        );
      } catch (err) {
        throw new Error(
          `Could not decrypt pdf password ciphertext: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(`[${job.id}] Gathering data for company ${companyId}`);
    let data;
    try {
      data = await this.exportData.gather(companyId, { includePasswords });
      await this.hydrateArticleImages(companyId, data);
    } catch (err) {
      await this.recordFailure(exportId, companyId, includePasswords, err);
      throw err;
    }

    this.logger.log(`[${job.id}] Building PDF`);
    let pdfBuffer: Buffer;
    try {
      pdfBuffer = await buildCompanyExportPdf(data, { pdfPassword });
    } catch (err) {
      await this.recordFailure(exportId, companyId, includePasswords, err);
      throw err;
    }

    const storageKey = this.storage.exportKey(companyId, exportId);
    this.logger.log(`[${job.id}] Writing PDF to storage (key=${storageKey})`);
    try {
      await this.storage.putObject(companyId, storageKey, pdfBuffer, {
        contentType: 'application/pdf',
      });
    } catch (err) {
      await this.recordFailure(exportId, companyId, includePasswords, err);
      throw err;
    }

    if (this.cleanupProducer) {
      await this.cleanupProducer.add(
        CompanyExportJobNames.cleanup,
        { kind: 'cleanup', storageKey, companyId },
        {
          delay: CLEANUP_DELAY_MS,
          attempts: 3,
          backoff: { type: 'fixed', delay: 60_000 },
          removeOnComplete: { age: 60 * 60 },
          removeOnFail: { age: 24 * 60 * 60 },
        },
      );
    }

    await this.audit.log({
      actorId: null,
      action: AUDIT_ACTIONS.export.completed,
      entityType: 'CompanyExport',
      entityId: exportId,
      companyId,
      ip: '127.0.0.1',
      userAgent: 'weavestream-worker/company-pdf-export',
      before: null,
      after: {
        includePasswords,
        sizeBytes: pdfBuffer.length,
        pdfPasswordProtected: Boolean(pdfPassword),
      },
    });

    this.logger.log(`[${job.id}] Export complete (${pdfBuffer.length} bytes)`);
    return { companyId, storageKey, sizeBytes: pdfBuffer.length };
  }

  private async handleCleanup(
    payload: Extract<CompanyExportJob, { kind: 'cleanup' }>,
  ): Promise<void> {
    const { companyId, storageKey } = payload;
    this.logger.log(`Cleaning up export ${storageKey} for company ${companyId}`);
    try {
      await this.storage.deleteObject(companyId, storageKey);
      this.logger.log(`Deleted export ${storageKey}`);
    } catch (err) {
      // Object may already be gone — log and swallow so the job completes cleanly.
      this.logger.warn(
        `Could not delete export ${storageKey}: ${(err as Error).message}`,
      );
    }
  }

  private async hydrateArticleImages(
    companyId: string,
    data: CompanyExportData,
  ): Promise<void> {
    const cache = new Map<string, Buffer | null>();
    for (const article of data.articles) {
      for (const image of article.images) {
        if (!isPdfEmbeddableImage(image.mimeType)) continue;
        // WS-027: pdfkit fully decodes whatever buffer it is handed, so
        // images blocked by the size gate never have their bytes read off
        // disk. The render side re-checks the same predicate and prints a
        // fallback line with the reason.
        if (pdfEmbedSizeBlockReason(image.width, image.height) !== null) continue;
        const cached = cache.get(image.storageKey);
        if (cached !== undefined) {
          if (cached) image.data = cached;
          continue;
        }

        try {
          const body = await this.storage.getObjectBody(companyId, image.storageKey);
          cache.set(image.storageKey, body);
          image.data = body;
        } catch (err) {
          cache.set(image.storageKey, null);
          this.logger.warn(
            `Could not hydrate article image ${image.uploadId}: ${(err as Error).message}`,
          );
        }
      }
    }
  }

  private async recordFailure(
    exportId: string,
    companyId: string,
    includePasswords: boolean,
    err: unknown,
  ): Promise<void> {
    try {
      await this.audit.log({
        actorId: null,
        action: AUDIT_ACTIONS.export.failed,
        entityType: 'CompanyExport',
        entityId: exportId,
        companyId,
        ip: '127.0.0.1',
        userAgent: 'weavestream-worker/company-pdf-export',
        before: null,
        after: {
          includePasswords,
          message: (err as Error)?.message ?? 'unknown error',
        },
      });
    } catch (auditErr) {
      // Audit failures must not mask the underlying error — the worker
      // still throws below so BullMQ retries / fails the job normally.
      this.logger.warn(
        `Could not record export.failed audit row: ${(auditErr as Error).message}`,
      );
    }
  }
}

function isPdfEmbeddableImage(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized === 'image/png' || normalized === 'image/jpeg';
}
