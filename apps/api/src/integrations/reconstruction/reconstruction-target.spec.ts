import {
  blockedOutcome,
  buildProvenance,
  contextGap,
  invalidInputOutcome,
  type AssetReconstructionInput,
  type ReconstructionWriteContext,
} from './reconstruction-target.js';

const ids = {
  company: '40000000-0000-0000-0000-000000000001',
  integration: '40000000-0000-0000-0000-000000000002',
  mapping: '40000000-0000-0000-0000-000000000003',
  resource: '40000000-0000-0000-0000-000000000004',
  actor: '40000000-0000-0000-0000-000000000005',
  target: '40000000-0000-0000-0000-000000000006',
  layout: '40000000-0000-0000-0000-000000000007',
};

const input: AssetReconstructionInput = {
  targetKind: 'asset',
  externalId: 'org-1:devices:device-1',
  source: { externalOrgId: 'org-1', resourceKey: 'devices', sourceId: 'device-1' },
  name: 'Device 1',
  assetLayoutId: ids.layout,
  matchKeyFieldIds: [],
  fieldValues: [],
};

function context(overrides: Partial<ReconstructionWriteContext> = {}): ReconstructionWriteContext {
  return {
    tx: {} as never,
    companyId: ids.company,
    integrationId: ids.integration,
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    resourceKey: 'devices',
    externalOrgId: 'org-1',
    auditActorId: ids.actor,
    now: new Date('2026-07-14T00:00:00.000Z'),
    dryRun: false,
    resolveBinding: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('reconstruction safety outcomes', () => {
  it('uses one non-secret checksum sentinel for distinct rejected inputs', () => {
    const first = blockedOutcome(
      context(),
      { ...input, name: 'Bearer first-secret-value' },
      { kind: 'validation', message: 'Sensitive reconstruction input was rejected.', details: { reasonCode: 'sensitive_input' } },
    );
    const second = blockedOutcome(
      context(),
      { ...input, name: 'Bearer second-secret-value' },
      { kind: 'validation', message: 'Sensitive reconstruction input was rejected.', details: { reasonCode: 'sensitive_input' } },
    );

    expect(first.checksum).toBe(second.checksum);
    expect(first.checksum).not.toContain('first-secret-value');
    expect(second.checksum).not.toContain('second-secret-value');
  });

  it('reuses a prior successful checksum without hashing blocked input', () => {
    const previousChecksum = 'a'.repeat(64);
    const previousProvenance = buildProvenance(context(), input);
    const out = blockedOutcome(
      context({ previousChecksum, previousProvenance }),
      { ...input, name: 'Bearer rejected-secret-value' },
      { kind: 'validation', message: 'Rejected.', details: { reasonCode: 'sensitive_input' } },
    );
    expect(out.checksum).toBe(previousChecksum);
  });

  it('preserves the last successful sync time when a later attempt is blocked', () => {
    const previousProvenance = buildProvenance(
      context({ now: new Date('2026-07-13T00:00:00.000Z') }),
      input,
    );
    const blocked = buildProvenance(context({ previousProvenance }), input, 'blocked');
    expect(blocked.lastSyncedAt).toBe('2026-07-13T00:00:00.000Z');
    expect(blocked.lastSeenAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('uses null successful-sync time for a never-successful blocked attempt', () => {
    expect(buildProvenance(context(), input, 'blocked').lastSyncedAt).toBeNull();
  });

  it('requires matching active Breeze provenance for an arbitrary existing target', () => {
    const gap = contextGap(context({ existingTargetId: ids.target }), input);
    expect(gap).toMatchObject({ details: { reasonCode: 'manual_ownership' } });
  });

  it('permits an exact Breeze-owned blocked binding to recover on a later valid source record', () => {
    const blocked = buildProvenance(context(), input, 'blocked');
    expect(contextGap(context({
      existingTargetId: ids.target,
      previousProvenance: blocked,
    }), input)).toBeNull();
  });

  it('does not replace manual provenance when a bound retry is malformed', () => {
    const manual = {
      ...buildProvenance(context(), input),
      ownership: 'weavestream' as const,
      externalOrgId: 'manual-org',
      resourceKey: 'manual-assets',
      externalId: 'manual-org:manual-assets:asset-1',
    };
    const out = invalidInputOutcome(
      context({ existingTargetId: ids.target, previousProvenance: manual }),
      'asset',
    );
    expect(out.provenance).toMatchObject({
      ownership: 'weavestream',
      externalOrgId: 'manual-org',
      externalId: manual.externalId,
    });
  });
});
