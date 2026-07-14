import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  integrationProvenanceSchema,
  type IntegrationSyncDirectionValue,
  type IntegrationTargetKind,
  type ReconstructionGapKind,
  type SafeIntegrationProvenance,
} from '@weavestream/shared';

const MAX_INPUT_BYTES = 262_144;
const MAX_INPUT_DEPTH = 8;
const MAX_INPUT_ENTRIES = 1_024;
const BLOCKED_CHECKSUM = createHash('sha256')
  .update('weavestream-reconstruction-blocked-v1')
  .digest('hex');

const sourceRefSchema = z
  .object({
    externalOrgId: z.string().min(1).max(256),
    resourceKey: z.string().min(1).max(256),
    sourceId: z.string().min(1).max(256),
    revision: z.string().max(256).nullable().optional(),
    fingerprint: z.string().max(256).nullable().optional(),
    updatedAt: z.string().datetime().nullable().optional(),
  })
  .strict();

const dependencyRefSchema = z
  .object({
    resourceKey: z.string().min(1).max(256),
    externalId: z.string().min(1).max(1024),
  })
  .strict();

const baseShape = {
  externalId: z.string().min(1).max(1024),
  source: sourceRefSchema,
} as const;

const assetFieldValueSchema = z
  .object({
    targetFieldId: z.string().uuid(),
    value: z.unknown(),
    syncDirection: z.enum(['source_wins', 'preserve_manual', 'manual_only']),
  })
  .strict();

export const assetReconstructionInputSchema = z
  .object({
    ...baseShape,
    targetKind: z.literal('asset'),
    name: z.string().trim().min(1).max(200),
    assetLayoutId: z.string().uuid(),
    externalSource: z.string().trim().min(1).max(80).optional(),
    matchKeyFieldIds: z.array(z.string().uuid()).max(128),
    fieldValues: z.array(assetFieldValueSchema).max(1024),
    bindingResourceKey: z.string().min(1).max(256).optional(),
  })
  .strict()
  .superRefine(assertBoundedReconstructionInput);

export const subnetReconstructionInputSchema = z
  .object({
    ...baseShape,
    targetKind: z.literal('subnet'),
    name: z.string().trim().min(1).max(200),
    cidr: z.string().trim().min(1).max(18),
    vlanId: z.number().int().min(1).max(4094).nullable().optional(),
    gateway: z.string().trim().max(15).nullable().optional(),
    dhcpRangeStart: z.string().trim().max(15).nullable().optional(),
    dhcpRangeEnd: z.string().trim().max(15).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine(assertBoundedReconstructionInput);

export const ipReservationReconstructionInputSchema = z
  .object({
    ...baseShape,
    targetKind: z.literal('ip_reservation'),
    subnetRef: dependencyRefSchema,
    ipAddress: z.string().trim().min(1).max(15),
    label: z.string().trim().min(1).max(200),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  .superRefine(assertBoundedReconstructionInput);

export const articleReconstructionInputSchema = z
  .object({
    ...baseShape,
    targetKind: z.literal('article'),
    title: z.string().trim().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    folderId: z.string().uuid().nullable(),
    markdown: z.string().min(1).max(1_000_000),
    visibleToClients: z.boolean(),
  })
  .strict()
  .superRefine(assertBoundedReconstructionInput);

export const relationReconstructionInputSchema = z
  .object({
    ...baseShape,
    targetKind: z.literal('relation'),
    sourceRef: dependencyRefSchema,
    targetRef: dependencyRefSchema,
    relationType: z.string().trim().min(1).max(128),
  })
  .strict()
  .superRefine(assertBoundedReconstructionInput);

export const reconstructionInputSchema = z.union([
  assetReconstructionInputSchema,
  subnetReconstructionInputSchema,
  ipReservationReconstructionInputSchema,
  articleReconstructionInputSchema,
  relationReconstructionInputSchema,
]);

export type ReconstructionSourceRef = z.infer<typeof sourceRefSchema>;
export type ReconstructionDependencyRef = z.infer<typeof dependencyRefSchema>;
export type AssetReconstructionInput = z.input<typeof assetReconstructionInputSchema>;
export type SubnetReconstructionInput = z.input<typeof subnetReconstructionInputSchema>;
export type IpReservationReconstructionInput = z.input<
  typeof ipReservationReconstructionInputSchema
>;
export type ArticleReconstructionInput = z.input<typeof articleReconstructionInputSchema>;
export type RelationReconstructionInput = z.input<typeof relationReconstructionInputSchema>;
export type ReconstructionInput =
  | AssetReconstructionInput
  | SubnetReconstructionInput
  | IpReservationReconstructionInput
  | ArticleReconstructionInput
  | RelationReconstructionInput;

declare const validatedReconstructionInput: unique symbol;
export type ValidatedReconstructionInput<T extends ReconstructionInput> = Readonly<T> & {
  readonly [validatedReconstructionInput]: true;
};

export interface ReconstructionGapDetails {
  reasonCode?: string;
  fieldPaths?: string[];
  dependencyResourceKey?: string;
  dependencyExternalId?: string;
  validationCodes?: string[];
  unsupportedCapability?: string;
  candidateCount?: number;
  sourceResource?: string;
  sourceOrgId?: string;
  sourceId?: string;
  targetKind?: IntegrationTargetKind;
  targetId?: string;
  statusCode?: number;
  retryable?: boolean;
  schemaVersion?: number;
}

export interface ReconstructionGapInput {
  kind: ReconstructionGapKind;
  message: string;
  externalId?: string | null;
  details?: ReconstructionGapDetails;
}

export interface ResolvedReconstructionTarget {
  targetKind: IntegrationTargetKind;
  targetId: string;
  companyId: string;
  resourceId?: string;
  externalId?: string;
}

export interface ReconstructionWriteContext {
  tx: Prisma.TransactionClient;
  companyId: string;
  integrationId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  resourceKey: string;
  externalOrgId: string;
  auditActorId: string;
  now: Date;
  dryRun: boolean;
  existingTargetId?: string | null;
  existingState?: 'active' | 'stale' | 'blocked' | null;
  previousChecksum?: string | null;
  previousFieldChecksums?: Readonly<Record<string, string>>;
  previousProvenance?: SafeIntegrationProvenance | null;
  resolveBinding(
    ref: ReconstructionDependencyRef,
  ): Promise<ResolvedReconstructionTarget | null>;
}

export interface ReconstructionWriteOutcome {
  targetKind: IntegrationTargetKind;
  targetId: string;
  checksum: string;
  change: 'created' | 'updated' | 'unchanged' | 'restored' | 'blocked';
  provenance: SafeIntegrationProvenance;
  gaps: ReconstructionGapInput[];
  fieldChecksums?: Record<string, string>;
}

export interface ReconstructionWriter<T extends ReconstructionInput> {
  readonly targetKind: T['targetKind'];
  validate(input: T): ValidatedReconstructionInput<T>;
  write(ctx: ReconstructionWriteContext, input: T): Promise<ReconstructionWriteOutcome>;
}

export interface NativeIntegrationWriteResult {
  targetId: string;
  companyId: string;
  change: 'created' | 'updated' | 'unchanged' | 'restored' | 'blocked';
  gap?: ReconstructionGapInput;
  fieldChecksums?: Record<string, string>;
}

export function validated<T extends ReconstructionInput>(input: T): ValidatedReconstructionInput<T> {
  return input as ValidatedReconstructionInput<T>;
}

export function computeReconstructionChecksum(input: ReconstructionInput): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(input))).digest('hex');
}

export function buildProvenance(
  ctx: ReconstructionWriteContext,
  input: ReconstructionInput,
  state: 'active' | 'blocked' = 'active',
): SafeIntegrationProvenance {
  const at = ctx.now.toISOString();
  const previous = state === 'blocked' ? ctx.previousProvenance : null;
  return integrationProvenanceSchema.parse({
    integrationId: previous?.integrationId ?? ctx.integrationId,
    externalOrgId: previous?.externalOrgId ?? input.source.externalOrgId,
    resourceKey: previous?.resourceKey ?? input.source.resourceKey,
    externalId: previous?.externalId ?? input.externalId,
    sourceRevision: previous?.sourceRevision ?? input.source.revision ?? null,
    sourceFingerprint: previous?.sourceFingerprint ?? input.source.fingerprint ?? null,
    firstSeenAt: ctx.previousProvenance?.firstSeenAt ?? at,
    lastSeenAt: at,
    lastSyncedAt: state === 'blocked' ? previous?.lastSyncedAt ?? null : at,
    ownership: previous?.ownership ?? 'breeze',
    state,
  });
}

export function contextGap(
  ctx: ReconstructionWriteContext,
  input: ReconstructionInput,
): ReconstructionGapInput | null {
  if (
    input.source.externalOrgId !== ctx.externalOrgId ||
    input.source.resourceKey !== ctx.resourceKey
  ) {
    return safeGap('validation', 'Source identity does not match the write context.', {
      reasonCode: 'source_context_mismatch',
    });
  }
  const previous = ctx.previousProvenance;
  if (ctx.existingTargetId && (!previous || previous.ownership !== 'breeze' || previous.state === 'blocked')) {
    return safeGap('ambiguous', 'The existing target is not owned by an active Breeze binding.', {
      reasonCode: 'manual_ownership',
      candidateCount: 1,
    });
  }
  if (previous?.ownership === 'weavestream') {
    return safeGap('ambiguous', 'The existing target is manually owned.', {
      reasonCode: 'manual_ownership',
      candidateCount: 1,
    });
  }
  if (
    previous &&
    (previous.integrationId !== ctx.integrationId ||
      previous.externalOrgId !== input.source.externalOrgId ||
      previous.resourceKey !== input.source.resourceKey ||
      previous.externalId !== input.externalId)
  ) {
    return safeGap('ambiguous', 'The existing binding belongs to a different source identity.', {
      reasonCode: 'source_identity_collision',
      candidateCount: 1,
    });
  }
  return null;
}

export function nativeWriteErrorOutcome(
  ctx: ReconstructionWriteContext,
  input: ReconstructionInput,
  error: unknown,
): ReconstructionWriteOutcome {
  const status =
    error &&
    typeof error === 'object' &&
    'getStatus' in error &&
    typeof (error as { getStatus?: unknown }).getStatus === 'function'
      ? (error as { getStatus(): number }).getStatus()
      : null;
  if (status === 404) {
    return blockedOutcome(
      ctx,
      input,
      safeGap('missing_dependency', 'A native target dependency was not found.', {
        reasonCode: 'native_dependency_not_found',
      }),
    );
  }
  if (status === 409) {
    return blockedOutcome(
      ctx,
      input,
      safeGap('ambiguous', 'A native target uniqueness constraint blocked the write.', {
        reasonCode: 'native_uniqueness_conflict',
      }),
    );
  }
  if (status === 400 || status === 422) {
    return blockedOutcome(
      ctx,
      input,
      safeGap('validation', 'Native target validation blocked the write.', {
        reasonCode: 'native_validation',
      }),
    );
  }
  return blockedOutcome(
    ctx,
    input,
    safeGap('synchronization_error', 'The native target write failed.', {
      reasonCode: 'native_write_failed',
      retryable: true,
    }),
  );
}

export function blockedOutcome(
  ctx: ReconstructionWriteContext,
  input: ReconstructionInput,
  gap: ReconstructionGapInput,
  targetId = ctx.existingTargetId ?? '',
): ReconstructionWriteOutcome {
  return {
    targetKind: input.targetKind,
    targetId,
    checksum: safeBlockedChecksum(ctx),
    change: 'blocked',
    provenance: buildProvenance(ctx, input, 'blocked'),
    gaps: [gap],
  };
}

export function invalidInputOutcome(
  ctx: ReconstructionWriteContext,
  targetKind: IntegrationTargetKind,
): ReconstructionWriteOutcome {
  const at = ctx.now.toISOString();
  const externalId = `${ctx.externalOrgId}:${ctx.resourceKey}:invalid`.slice(0, 1024);
  const previous = ctx.previousProvenance;
  const provenance = integrationProvenanceSchema.parse({
    integrationId: previous?.integrationId ?? ctx.integrationId,
    externalOrgId: previous?.externalOrgId ?? (ctx.externalOrgId.slice(0, 256) || 'invalid'),
    resourceKey: previous?.resourceKey ?? (ctx.resourceKey.slice(0, 256) || 'invalid'),
    externalId: previous?.externalId ?? externalId,
    sourceRevision: previous?.sourceRevision ?? null,
    sourceFingerprint: previous?.sourceFingerprint ?? null,
    firstSeenAt: previous?.firstSeenAt ?? at,
    lastSeenAt: at,
    lastSyncedAt: previous?.lastSyncedAt ?? null,
    ownership: previous?.ownership ?? 'breeze',
    state: 'blocked',
  });
  return {
    targetKind,
    targetId: ctx.existingTargetId ?? '',
    checksum: safeBlockedChecksum(ctx),
    change: 'blocked',
    provenance,
    gaps: [validationGap()],
  };
}

export function sensitiveInputOutcome(
  ctx: ReconstructionWriteContext,
  targetKind: IntegrationTargetKind,
): ReconstructionWriteOutcome {
  const at = ctx.now.toISOString();
  return {
    targetKind,
    targetId: ctx.existingTargetId ?? '',
    checksum: safeBlockedChecksum(ctx),
    change: 'blocked',
    provenance: integrationProvenanceSchema.parse({
      integrationId: ctx.previousProvenance?.integrationId ?? ctx.integrationId,
      externalOrgId: ctx.previousProvenance?.externalOrgId ?? 'rejected',
      resourceKey: ctx.previousProvenance?.resourceKey ?? 'rejected',
      externalId: ctx.previousProvenance?.externalId ?? 'rejected:rejected:rejected',
      sourceRevision: ctx.previousProvenance?.sourceRevision ?? null,
      sourceFingerprint: ctx.previousProvenance?.sourceFingerprint ?? null,
      firstSeenAt: ctx.previousProvenance?.firstSeenAt ?? at,
      lastSeenAt: at,
      lastSyncedAt: ctx.previousProvenance?.lastSyncedAt ?? null,
      ownership: ctx.previousProvenance?.ownership ?? 'breeze',
      state: 'blocked',
    }),
    gaps: [safeGap('validation', 'Sensitive reconstruction input was rejected.', {
      reasonCode: 'sensitive_input',
    })],
  };
}

export function boundedInputOutcome(
  ctx: ReconstructionWriteContext,
  targetKind: IntegrationTargetKind,
): ReconstructionWriteOutcome {
  const outcome = sensitiveInputOutcome(ctx, targetKind);
  return {
    ...outcome,
    gaps: [safeGap('validation', 'Reconstruction input exceeded safe traversal bounds.', {
      reasonCode: 'input_bounds_exceeded',
    })],
  };
}

function safeBlockedChecksum(ctx: ReconstructionWriteContext): string {
  if (
    ctx.previousProvenance &&
    ctx.previousProvenance.state !== 'blocked' &&
    typeof ctx.previousChecksum === 'string' &&
    /^[a-f0-9]{64}$/i.test(ctx.previousChecksum)
  ) {
    return ctx.previousChecksum.toLowerCase();
  }
  return BLOCKED_CHECKSUM;
}

export function completedOutcome(
  ctx: ReconstructionWriteContext,
  input: ReconstructionInput,
  result: NativeIntegrationWriteResult,
): ReconstructionWriteOutcome {
  if (result.companyId !== ctx.companyId) {
    return blockedOutcome(
      ctx,
      input,
      safeGap('validation', 'The resolved target is outside the write company.', {
        reasonCode: 'target_company_mismatch',
        targetKind: input.targetKind,
      }),
      result.targetId,
    );
  }
  if (result.change === 'blocked') {
    return blockedOutcome(
      ctx,
      input,
      result.gap ??
        safeGap('synchronization_error', 'The native target write was blocked.', {
          reasonCode: 'native_write_blocked',
        }),
      result.targetId,
    );
  }
  const change = ctx.existingState === 'stale' ? 'restored' : result.change;
  return {
    targetKind: input.targetKind,
    targetId: result.targetId,
    checksum: computeReconstructionChecksum(input),
    change,
    provenance: buildProvenance(ctx, input),
    gaps: [],
    ...(result.fieldChecksums ? { fieldChecksums: result.fieldChecksums } : {}),
  };
}

export function safeGap(
  kind: ReconstructionGapKind,
  message: string,
  details: ReconstructionGapDetails = {},
): ReconstructionGapInput {
  return {
    kind,
    message: message.slice(0, 512),
    details,
  };
}

export function validationGap(): ReconstructionGapInput {
  return safeGap('validation', 'Reconstruction input is invalid.', {
    reasonCode: 'invalid_input',
  });
}

export function namespacedExternalId(input: ReconstructionInput, resourceKey: string): string {
  return `${input.source.externalOrgId}:${resourceKey}:${input.source.sourceId}`;
}

export type AssetReconstructionFieldValue = {
  targetFieldId: string;
  value: unknown;
  syncDirection: IntegrationSyncDirectionValue;
};

function assertBoundedReconstructionInput(value: unknown, ctx: z.RefinementCtx): void {
  if (value && typeof value === 'object') {
    const candidate = value as {
      externalId?: unknown;
      source?: { externalOrgId?: unknown; resourceKey?: unknown; sourceId?: unknown };
    };
    const expected =
      candidate.source &&
      typeof candidate.source.externalOrgId === 'string' &&
      typeof candidate.source.resourceKey === 'string' &&
      typeof candidate.source.sourceId === 'string'
        ? `${candidate.source.externalOrgId}:${candidate.source.resourceKey}:${candidate.source.sourceId}`
        : null;
    if (expected !== null && candidate.externalId !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['externalId'],
        message: 'externalId must be the fully namespaced source identity.',
      });
    }
  }
  try {
    const measured = measureJson(value);
    if (measured.bytes > MAX_INPUT_BYTES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Input exceeds 262144 UTF-8 bytes.' });
    }
    if (measured.depth > MAX_INPUT_DEPTH) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Input nesting exceeds 8 levels.' });
    }
    if (measured.entries > MAX_INPUT_ENTRIES) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Input exceeds 1024 entries.' });
    }
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Input must be finite JSON.' });
  }
}

function measureJson(value: unknown): { bytes: number; depth: number; entries: number } {
  const seen = new Set<object>();
  let maxDepth = 0;
  let entries = 0;
  const visit = (entry: unknown, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    if (entry === undefined || typeof entry === 'bigint' || typeof entry === 'function' || typeof entry === 'symbol') {
      throw new Error('not JSON');
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('not finite');
    if (!entry || typeof entry !== 'object') return;
    if (seen.has(entry)) throw new Error('recursive');
    seen.add(entry);
    const children = Array.isArray(entry)
      ? entry
      : Object.values(entry as Record<string, unknown>);
    entries += children.length;
    for (const child of children) visit(child, depth + 1);
    seen.delete(entry);
  };
  visit(value, 0);
  return { bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'), depth: maxDepth, entries };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalJson(entry)]),
    );
  }
  return value;
}
