import { Injectable } from '@nestjs/common';
import {
  blockedOutcome,
  completedOutcome,
  contextGap,
  invalidInputOutcome,
  nativeWriteErrorOutcome,
  relationReconstructionInputSchema,
  safeGap,
  validated,
  type NativeIntegrationWriteResult,
  type ReconstructionWriteContext,
  type ReconstructionWriteOutcome,
  type ReconstructionWriter,
  type RelationReconstructionInput,
  type ValidatedReconstructionInput,
} from './reconstruction-target.js';

export interface RelationIntegrationWriteInput {
  companyId: string;
  integrationId: string;
  auditActorId: string;
  dryRun: boolean;
  existingTargetId?: string | null;
  sourceType: 'Asset' | 'Article';
  sourceId: string;
  targetType: 'Asset' | 'Article';
  targetId: string;
  relationType: string;
}

export interface RelationIntegrationWritePort {
  writeFromIntegration(input: RelationIntegrationWriteInput): Promise<NativeIntegrationWriteResult>;
}

@Injectable()
export class RelationTargetWriter implements ReconstructionWriter<RelationReconstructionInput> {
  readonly targetKind = 'relation' as const;

  constructor(private readonly relations: RelationIntegrationWritePort) {}

  validate(
    input: RelationReconstructionInput,
  ): ValidatedReconstructionInput<RelationReconstructionInput> {
    return validated(relationReconstructionInputSchema.parse(input));
  }

  async write(
    ctx: ReconstructionWriteContext,
    rawInput: RelationReconstructionInput,
  ): Promise<ReconstructionWriteOutcome> {
    let input: ValidatedReconstructionInput<RelationReconstructionInput>;
    try {
      input = this.validate(rawInput);
    } catch {
      return invalidInputOutcome(ctx, this.targetKind);
    }
    const identityGap = contextGap(ctx, input);
    if (identityGap) return blockedOutcome(ctx, input, identityGap);
    const [source, target] = await Promise.all([
      ctx.resolveBinding(input.sourceRef),
      ctx.resolveBinding(input.targetRef),
    ]);
    if (!source || !target) {
      const ref = !source ? input.sourceRef : input.targetRef;
      return blockedOutcome(
        ctx,
        input,
        safeGap('missing_dependency', 'A relation endpoint dependency was not found.', {
          reasonCode: 'dependency_not_found',
          dependencyResourceKey: ref.resourceKey,
        }),
      );
    }
    if (source.companyId !== ctx.companyId || target.companyId !== ctx.companyId) {
      return blockedOutcome(
        ctx,
        input,
        safeGap('validation', 'Relation endpoints must belong to the write company.', {
          reasonCode: 'dependency_company_mismatch',
        }),
      );
    }
    if (!isSupportedEndpoint(source.targetKind) || !isSupportedEndpoint(target.targetKind)) {
      return blockedOutcome(
        ctx,
        input,
        safeGap('unsupported', 'The relation endpoint kind is not supported.', {
          reasonCode: 'unsupported_endpoint_kind',
          unsupportedCapability: 'relation_endpoint_kind',
        }),
      );
    }
    try {
      const result = await this.relations.writeFromIntegration({
        companyId: ctx.companyId,
        integrationId: ctx.integrationId,
        auditActorId: ctx.auditActorId,
        dryRun: ctx.dryRun,
        existingTargetId: ctx.existingTargetId,
        sourceType: source.targetKind === 'asset' ? 'Asset' : 'Article',
        sourceId: source.targetId,
        targetType: target.targetKind === 'asset' ? 'Asset' : 'Article',
        targetId: target.targetId,
        relationType: input.relationType,
      });
      return completedOutcome(ctx, input, result);
    } catch (error) {
      return nativeWriteErrorOutcome(ctx, input, error);
    }
  }
}

function isSupportedEndpoint(kind: string): kind is 'asset' | 'article' {
  return kind === 'asset' || kind === 'article';
}
