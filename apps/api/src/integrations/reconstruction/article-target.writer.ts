import { Injectable } from '@nestjs/common';
import { containsSensitiveMaterial } from '../sensitive-material.js';
import {
  articleReconstructionInputSchema,
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
  companyId: string;
  integrationId: string;
  auditActorId: string;
  dryRun: boolean;
  existingTargetId?: string | null;
  ownershipVerified: boolean;
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
    if (containsSensitiveMaterial(rawInput)) {
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
        companyId: ctx.companyId,
        integrationId: ctx.integrationId,
        auditActorId: ctx.auditActorId,
        dryRun: ctx.dryRun,
        existingTargetId: ctx.existingTargetId,
        ownershipVerified: ctx.existingTargetId != null,
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
