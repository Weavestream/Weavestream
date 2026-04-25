import { Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  QueueNames,
  type CompanyExportJob,
  type ExportJobResult,
} from '@weavestream/shared';
import { QueuesService } from '../queues/queues.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MinioService } from '../storage/minio.service.js';
import { SecretEncryptionService } from '../crypto/secret-encryption.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

export interface ExportJobStatus {
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'unknown';
  downloadUrl?: string;
  downloadExpiresAt?: string;
  error?: string;
}

const PRESIGN_TTL_SECONDS = 7200; // 2 hours

export interface TriggerActorMeta {
  ip: string;
  userAgent: string;
}

@Injectable()
export class ExportsService {
  constructor(
    private readonly queues: QueuesService,
    private readonly prisma: PrismaService,
    private readonly minio: MinioService,
    private readonly crypto: SecretEncryptionService,
    private readonly audit: AuditLogService,
  ) {}

  async triggerExport(
    actor: AuthedUser,
    companyId: string,
    opts: { includePasswords: boolean; pdfPassword?: string },
    meta: TriggerActorMeta,
  ): Promise<{ jobId: string; exportId: string }> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true },
    });
    if (!company) throw new NotFoundException(`Company ${companyId} not found`);

    const exportId = randomUUID();

    // Encrypt the user-supplied PDF password before it ever lands in
    // Redis. Same envelope (AES-256-GCM, kid-tagged) the password vault
    // uses, so a Redis dump alone is not enough to recover it.
    const pdfPasswordCiphertext = opts.pdfPassword
      ? this.crypto.encrypt(opts.pdfPassword)
      : undefined;

    const payload: CompanyExportJob = {
      kind: 'export',
      exportId,
      companyId,
      includePasswords: opts.includePasswords,
      ...(pdfPasswordCiphertext ? { pdfPasswordCiphertext } : {}),
    };
    const jobId = await this.queues.enqueueCompanyExport(payload);

    await this.audit.log({
      actorId: actor.id,
      action: AUDIT_ACTIONS.export.triggered,
      entityType: 'CompanyExport',
      entityId: exportId,
      companyId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      before: null,
      after: {
        companyName: company.name,
        includePasswords: opts.includePasswords,
        pdfPasswordProtected: Boolean(opts.pdfPassword),
        jobId,
      },
    });

    return { jobId, exportId };
  }

  async getJobStatus(jobId: string): Promise<ExportJobStatus> {
    const queue = this.queues.get(QueueNames.companyExport);
    const job = await queue.getJob(jobId);
    if (!job) return { status: 'unknown' };

    const state = await job.getState();

    if (state === 'completed') {
      const result = job.returnvalue as ExportJobResult | undefined;
      if (!result?.storageKey) return { status: 'completed' };

      // Re-mint a fresh presigned URL on every poll so the link never
      // expires while the file is still in MinIO.
      const head = await this.minio.headObject(result.companyId, result.storageKey);
      if (!head) {
        // File already cleaned up — surface as `failed` so the
        // frontend stops polling. The job still exists in BullMQ; we
        // just can't hand out a download anymore.
        return {
          status: 'failed',
          error: 'Export file has expired and been deleted.',
        };
      }

      const { url, expiresAt } = await this.minio.presignGet(
        result.companyId,
        result.storageKey,
        {
          ttlSeconds: PRESIGN_TTL_SECONDS,
          contentDisposition: 'attachment; filename="vault-export.pdf"',
        },
      );
      return {
        status: 'completed',
        downloadUrl: url,
        downloadExpiresAt: expiresAt.toISOString(),
      };
    }

    if (state === 'failed') {
      return { status: 'failed', error: job.failedReason ?? 'Export failed.' };
    }

    if (state === 'active') return { status: 'active' };

    return { status: 'waiting' };
  }
}
