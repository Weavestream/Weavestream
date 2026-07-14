import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { scanSensitiveMaterial } from '../sensitive-material.js';
import {
  articleReconstructionInputSchema,
  boundedInputOutcome,
  blockedOutcome,
  completedOutcome,
  contextGap,
  invalidInputOutcome,
  nativeWriteErrorOutcome,
  sensitiveInputOutcome,
  validated,
  type ArticleReconstructionInput,
  type NativeIntegrationWriteResult,
  type ReconstructionWriteContext,
  type ReconstructionWriteOutcome,
  type ReconstructionWriter,
  type ValidatedReconstructionInput,
} from './reconstruction-target.js';

export interface ArticleIntegrationWriteInput {
  tx?: Prisma.TransactionClient;
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  externalId: string;
  auditActorId: string;
  dryRun: boolean;
  existingTargetId?: string | null;
  title: string;
  slug: string;
  folderId: string | null;
  markdown: string;
  visibleToClients: boolean;
}

export interface ArticleIntegrationWritePort {
  writeFromIntegration(input: ArticleIntegrationWriteInput): Promise<NativeIntegrationWriteResult>;
}

@Injectable()
export class ArticleTargetWriter implements ReconstructionWriter<ArticleReconstructionInput> {
  readonly targetKind = 'article' as const;

  constructor(private readonly articles: ArticleIntegrationWritePort) {}

  validate(
    input: ArticleReconstructionInput,
  ): ValidatedReconstructionInput<ArticleReconstructionInput> {
    return validated(articleReconstructionInputSchema.parse(input));
  }

  async write(
    ctx: ReconstructionWriteContext,
    rawInput: ArticleReconstructionInput,
  ): Promise<ReconstructionWriteOutcome> {
    const scan = scanSensitiveMaterial(rawInput);
    if (scan === 'bounds_exceeded') return boundedInputOutcome(ctx, this.targetKind);
    if (scan === 'sensitive') {
      return sensitiveInputOutcome(ctx, this.targetKind);
    }
    let input: ValidatedReconstructionInput<ArticleReconstructionInput>;
    try {
      input = this.validate(rawInput);
    } catch {
      return invalidInputOutcome(ctx, this.targetKind);
    }
    const gap = contextGap(ctx, input);
    if (gap) return blockedOutcome(ctx, input, gap);
    try {
      const result = await this.articles.writeFromIntegration({
        tx: ctx.tx,
        companyId: ctx.companyId,
        integrationId: ctx.integrationId,
        integrationCompanyMappingId: ctx.integrationCompanyMappingId,
        resourceId: ctx.resourceId,
        externalId: input.externalId,
        auditActorId: ctx.auditActorId,
        dryRun: ctx.dryRun,
        existingTargetId: ctx.existingTargetId,
        title: input.title,
        slug: input.slug,
        folderId: input.folderId,
        markdown: input.markdown,
        visibleToClients: input.visibleToClients,
      });
      return completedOutcome(ctx, input, result);
    } catch (error) {
      return nativeWriteErrorOutcome(ctx, input, error);
    }
  }
}
