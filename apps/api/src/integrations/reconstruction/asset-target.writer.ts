import { Injectable } from '@nestjs/common';
import type { IntegrationSyncDirectionValue } from '@weavestream/shared';
import { scanSensitiveMaterial } from '../sensitive-material.js';
import {
  assetReconstructionInputSchema,
  boundedInputOutcome,
  blockedOutcome,
  completedOutcome,
  contextGap,
  invalidInputOutcome,
  namespacedExternalId,
  nativeWriteErrorOutcome,
  safeGap,
  sensitiveInputOutcome,
  validated,
  type AssetReconstructionInput,
  type NativeIntegrationWriteResult,
  type ReconstructionWriteContext,
  type ReconstructionWriteOutcome,
  type ReconstructionWriter,
  type ValidatedReconstructionInput,
} from './reconstruction-target.js';

export interface AssetIntegrationWriteInput {
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  auditActorId: string;
  dryRun: boolean;
  externalId: string;
  externalSource?: string;
  existingTargetId?: string | null;
  name: string;
  assetLayoutId: string;
  matchKeyFieldIds: string[];
  fieldValues: Array<{
    targetFieldId: string;
    value: unknown;
    syncDirection: IntegrationSyncDirectionValue;
  }>;
  previousFieldChecksums: Readonly<Record<string, string>>;
}

export interface AssetIntegrationWritePort {
  writeFromIntegration(input: AssetIntegrationWriteInput): Promise<NativeIntegrationWriteResult>;
}

@Injectable()
export class AssetTargetWriter implements ReconstructionWriter<AssetReconstructionInput> {
  readonly targetKind = 'asset' as const;

  constructor(private readonly assets: AssetIntegrationWritePort) {}

  validate(
    input: AssetReconstructionInput,
  ): ValidatedReconstructionInput<AssetReconstructionInput> {
    return validated(assetReconstructionInputSchema.parse(input));
  }

  async write(
    ctx: ReconstructionWriteContext,
    rawInput: AssetReconstructionInput,
  ): Promise<ReconstructionWriteOutcome> {
    const scan = scanSensitiveMaterial(rawInput);
    if (scan === 'bounds_exceeded') return boundedInputOutcome(ctx, this.targetKind);
    if (scan === 'sensitive') {
      return sensitiveInputOutcome(ctx, this.targetKind);
    }
    let input: ValidatedReconstructionInput<AssetReconstructionInput>;
    try {
      input = this.validate(rawInput);
    } catch {
      return invalidInputOutcome(ctx, this.targetKind);
    }

    const identityGap = contextGap(ctx, input);
    if (identityGap) return blockedOutcome(ctx, input, identityGap);

    let existingTargetId = ctx.existingTargetId ?? null;
    if (input.bindingResourceKey) {
      const binding = await ctx.resolveBinding({
        resourceKey: input.bindingResourceKey,
        externalId: namespacedExternalId(input, input.bindingResourceKey),
      });
      if (!binding) {
        return blockedOutcome(
          ctx,
          input,
          safeGap('missing_dependency', 'The asset binding dependency was not found.', {
            reasonCode: 'dependency_not_found',
            dependencyResourceKey: input.bindingResourceKey,
          }),
        );
      }
      if (binding.companyId !== ctx.companyId || binding.targetKind !== 'asset') {
        return blockedOutcome(
          ctx,
          input,
          safeGap('validation', 'The asset binding dependency is not a same-company asset.', {
            reasonCode: 'dependency_company_or_kind_mismatch',
            dependencyResourceKey: input.bindingResourceKey,
          }),
          binding.targetId,
        );
      }
      if (existingTargetId && existingTargetId !== binding.targetId) {
        return blockedOutcome(
          ctx,
          input,
          safeGap('ambiguous', 'The existing target conflicts with the resolved asset binding.', {
            reasonCode: 'binding_target_collision',
            candidateCount: 2,
          }),
          existingTargetId,
        );
      }
      existingTargetId = binding.targetId;
    }

    try {
      const result = await this.assets.writeFromIntegration({
        companyId: ctx.companyId,
        integrationId: ctx.integrationId,
        integrationCompanyMappingId: ctx.integrationCompanyMappingId,
        resourceId: ctx.resourceId,
        auditActorId: ctx.auditActorId,
        dryRun: ctx.dryRun,
        externalId: input.externalId,
        ...(input.externalSource ? { externalSource: input.externalSource } : {}),
        existingTargetId,
        name: input.name,
        assetLayoutId: input.assetLayoutId,
        matchKeyFieldIds: [...input.matchKeyFieldIds],
        fieldValues: input.fieldValues.map((field) => ({
          targetFieldId: field.targetFieldId,
          value: field.value,
          syncDirection: field.syncDirection,
        })),
        previousFieldChecksums: ctx.previousFieldChecksums ?? {},
      });
      return completedOutcome(ctx, input, result);
    } catch (error) {
      return nativeWriteErrorOutcome(ctx, input, error);
    }
  }
}
