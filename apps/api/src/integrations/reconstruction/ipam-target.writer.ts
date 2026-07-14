import { Injectable } from '@nestjs/common';
import {
  createIpReservationSchema,
  createSubnetSchema,
} from '@weavestream/shared';
import { scanSensitiveMaterial } from '../sensitive-material.js';
import {
  blockedOutcome,
  boundedInputOutcome,
  completedOutcome,
  contextGap,
  ipReservationReconstructionInputSchema,
  invalidInputOutcome,
  nativeWriteErrorOutcome,
  safeGap,
  sensitiveInputOutcome,
  subnetReconstructionInputSchema,
  validated,
  type IpReservationReconstructionInput,
  type NativeIntegrationWriteResult,
  type ReconstructionWriteContext,
  type ReconstructionWriteOutcome,
  type ReconstructionWriter,
  type SubnetReconstructionInput,
  type ValidatedReconstructionInput,
} from './reconstruction-target.js';

export interface SubnetIntegrationWriteInput {
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  externalId: string;
  auditActorId: string;
  dryRun: boolean;
  existingTargetId?: string | null;
  name: string;
  cidr: string;
  vlanId?: number | null;
  gateway?: string | null;
  dhcpRangeStart?: string | null;
  dhcpRangeEnd?: string | null;
  description?: string | null;
}

export interface ReservationIntegrationWriteInput {
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  externalId: string;
  auditActorId: string;
  dryRun: boolean;
  existingTargetId?: string | null;
  subnetId: string;
  ipAddress: string;
  label: string;
  notes?: string | null;
}

export interface IpamIntegrationWritePort {
  writeSubnetFromIntegration(input: SubnetIntegrationWriteInput): Promise<NativeIntegrationWriteResult>;
  writeReservationFromIntegration(
    input: ReservationIntegrationWriteInput,
  ): Promise<NativeIntegrationWriteResult>;
}

@Injectable()
export class SubnetTargetWriter implements ReconstructionWriter<SubnetReconstructionInput> {
  readonly targetKind = 'subnet' as const;

  constructor(private readonly ipam: IpamIntegrationWritePort) {}

  validate(
    input: SubnetReconstructionInput,
  ): ValidatedReconstructionInput<SubnetReconstructionInput> {
    const parsed = subnetReconstructionInputSchema.parse(input);
    const native = createSubnetSchema.parse({
      name: parsed.name,
      cidr: parsed.cidr,
      vlanId: parsed.vlanId,
      gateway: parsed.gateway,
      dhcpRangeStart: parsed.dhcpRangeStart,
      dhcpRangeEnd: parsed.dhcpRangeEnd,
      description: parsed.description,
    });
    return validated({ ...parsed, ...native } as SubnetReconstructionInput);
  }

  async write(
    ctx: ReconstructionWriteContext,
    rawInput: SubnetReconstructionInput,
  ): Promise<ReconstructionWriteOutcome> {
    const scan = scanSensitiveMaterial(rawInput);
    if (scan === 'bounds_exceeded') return boundedInputOutcome(ctx, this.targetKind);
    if (scan === 'sensitive') {
      return sensitiveInputOutcome(ctx, this.targetKind);
    }
    let input: ValidatedReconstructionInput<SubnetReconstructionInput>;
    try {
      input = this.validate(rawInput);
    } catch {
      return invalidInputOutcome(ctx, this.targetKind);
    }
    const gap = contextGap(ctx, input);
    if (gap) return blockedOutcome(ctx, input, gap);
    try {
      const result = await this.ipam.writeSubnetFromIntegration({
        companyId: ctx.companyId,
        integrationId: ctx.integrationId,
        integrationCompanyMappingId: ctx.integrationCompanyMappingId,
        resourceId: ctx.resourceId,
        externalId: input.externalId,
        auditActorId: ctx.auditActorId,
        dryRun: ctx.dryRun,
        existingTargetId: ctx.existingTargetId,
        name: input.name,
        cidr: input.cidr,
        vlanId: input.vlanId,
        gateway: input.gateway,
        dhcpRangeStart: input.dhcpRangeStart,
        dhcpRangeEnd: input.dhcpRangeEnd,
        description: input.description,
      });
      return completedOutcome(ctx, input, result);
    } catch (error) {
      return nativeWriteErrorOutcome(ctx, input, error);
    }
  }
}

@Injectable()
export class IpReservationTargetWriter
  implements ReconstructionWriter<IpReservationReconstructionInput>
{
  readonly targetKind = 'ip_reservation' as const;

  constructor(private readonly ipam: IpamIntegrationWritePort) {}

  validate(
    input: IpReservationReconstructionInput,
  ): ValidatedReconstructionInput<IpReservationReconstructionInput> {
    const parsed = ipReservationReconstructionInputSchema.parse(input);
    const native = createIpReservationSchema.parse({
      ipAddress: parsed.ipAddress,
      label: parsed.label,
      notes: parsed.notes,
    });
    return validated({ ...parsed, ...native } as IpReservationReconstructionInput);
  }

  async write(
    ctx: ReconstructionWriteContext,
    rawInput: IpReservationReconstructionInput,
  ): Promise<ReconstructionWriteOutcome> {
    const scan = scanSensitiveMaterial(rawInput);
    if (scan === 'bounds_exceeded') return boundedInputOutcome(ctx, this.targetKind);
    if (scan === 'sensitive') {
      return sensitiveInputOutcome(ctx, this.targetKind);
    }
    let input: ValidatedReconstructionInput<IpReservationReconstructionInput>;
    try {
      input = this.validate(rawInput);
    } catch {
      return invalidInputOutcome(ctx, this.targetKind);
    }
    const identityGap = contextGap(ctx, input);
    if (identityGap) return blockedOutcome(ctx, input, identityGap);

    const subnet = await ctx.resolveBinding(input.subnetRef);
    if (!subnet) {
      return blockedOutcome(
        ctx,
        input,
        safeGap('missing_dependency', 'The reservation subnet dependency was not found.', {
          reasonCode: 'dependency_not_found',
          dependencyResourceKey: input.subnetRef.resourceKey,
        }),
      );
    }
    if (subnet.companyId !== ctx.companyId || subnet.targetKind !== 'subnet') {
      return blockedOutcome(
        ctx,
        input,
        safeGap('validation', 'The reservation dependency is not a same-company subnet.', {
          reasonCode: 'dependency_company_or_kind_mismatch',
          dependencyResourceKey: input.subnetRef.resourceKey,
        }),
        subnet.targetId,
      );
    }
    try {
      const result = await this.ipam.writeReservationFromIntegration({
        companyId: ctx.companyId,
        integrationId: ctx.integrationId,
        integrationCompanyMappingId: ctx.integrationCompanyMappingId,
        resourceId: ctx.resourceId,
        externalId: input.externalId,
        auditActorId: ctx.auditActorId,
        dryRun: ctx.dryRun,
        existingTargetId: ctx.existingTargetId,
        subnetId: subnet.targetId,
        ipAddress: input.ipAddress,
        label: input.label,
        notes: input.notes,
      });
      return completedOutcome(ctx, input, result);
    } catch (error) {
      return nativeWriteErrorOutcome(ctx, input, error);
    }
  }
}
