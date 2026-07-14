import { AssetTargetWriter, type AssetIntegrationWritePort } from './asset-target.writer.js';
import type { AssetReconstructionInput, ReconstructionWriteContext } from './reconstruction-target.js';

const ids = {
  company: '00000000-0000-0000-0000-000000000001',
  otherCompany: '00000000-0000-0000-0000-000000000002',
  integration: '00000000-0000-0000-0000-000000000003',
  mapping: '00000000-0000-0000-0000-000000000004',
  resource: '00000000-0000-0000-0000-000000000005',
  actor: '00000000-0000-0000-0000-000000000006',
  layout: '00000000-0000-0000-0000-000000000007',
  field: '00000000-0000-0000-0000-000000000008',
  asset: '00000000-0000-0000-0000-000000000009',
};

const input: AssetReconstructionInput = {
  targetKind: 'asset',
  externalId: 'org-1:devices:device-1',
  source: { externalOrgId: 'org-1', resourceKey: 'devices', sourceId: 'device-1', revision: '7' },
  name: 'Edge 01',
  assetLayoutId: ids.layout,
  externalSource: 'breeze',
  matchKeyFieldIds: [ids.field],
  fieldValues: [{ targetFieldId: ids.field, value: 'edge-01', syncDirection: 'preserve_manual' }],
};

function context(overrides: Partial<ReconstructionWriteContext> = {}): ReconstructionWriteContext {
  const ctx: ReconstructionWriteContext = {
    tx: {} as never,
    companyId: ids.company,
    integrationId: ids.integration,
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    resourceKey: 'devices',
    externalOrgId: 'org-1',
    auditActorId: ids.actor,
    now: new Date('2026-07-13T18:00:00.000Z'),
    dryRun: false,
    resolveBinding: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
  if (ctx.existingTargetId && overrides.previousProvenance === undefined) {
    ctx.previousProvenance = {
      integrationId: ids.integration,
      externalOrgId: 'org-1',
      resourceKey: 'devices',
      externalId: input.externalId,
      sourceRevision: '7',
      sourceFingerprint: null,
      firstSeenAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-01T00:00:00.000Z',
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
      ownership: 'breeze',
      state: ctx.existingState === 'stale' ? 'stale' : 'active',
    };
  }
  return ctx;
}

function setup(result: Partial<Awaited<ReturnType<AssetIntegrationWritePort['writeFromIntegration']>>> = {}) {
  const writeFromIntegration = jest.fn().mockResolvedValue({
    targetId: ids.asset,
    companyId: ids.company,
    change: 'created',
    fieldChecksums: { [ids.field]: 'field-checksum' },
    ...result,
  });
  return { writer: new AssetTargetWriter({ writeFromIntegration }), writeFromIntegration };
}

describe('AssetTargetWriter', () => {
  it('validates and creates through the native asset integration entry point', async () => {
    const { writer, writeFromIntegration } = setup();
    expect(writer.validate(input)).toMatchObject({ targetKind: 'asset', name: 'Edge 01' });
    const out = await writer.write(context(), input);
    expect(out).toMatchObject({ targetKind: 'asset', targetId: ids.asset, change: 'created', fieldChecksums: { [ids.field]: 'field-checksum' } });
    expect(writeFromIntegration).toHaveBeenCalledWith(expect.objectContaining({ companyId: ids.company, auditActorId: ids.actor, integrationId: ids.integration, matchKeyFieldIds: [ids.field] }));
  });

  it.each(['updated', 'unchanged'] as const)('returns %s when the native write reports it', async (change) => {
    const { writer } = setup({ change });
    await expect(writer.write(context({ existingTargetId: ids.asset }), input)).resolves.toMatchObject({ change });
  });

  it('reports restored when a stale binding is successfully reused', async () => {
    const { writer } = setup({ change: 'unchanged' });
    await expect(writer.write(context({ existingTargetId: ids.asset, existingState: 'stale' }), input)).resolves.toMatchObject({ change: 'restored' });
  });

  it('reports restored when a stale binding is reused and its fields are updated', async () => {
    const { writer } = setup({ change: 'updated' });
    await expect(
      writer.write(context({ existingTargetId: ids.asset, existingState: 'stale' }), input),
    ).resolves.toMatchObject({ change: 'restored' });
  });

  it('blocks an existing target returned from another company', async () => {
    const { writer } = setup({ companyId: ids.otherCompany });
    const out = await writer.write(context({ existingTargetId: ids.asset }), input);
    expect(out).toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
  });

  it('blocks a missing bindingResourceKey dependency without calling the asset service', async () => {
    const { writer, writeFromIntegration } = setup();
    const out = await writer.write(context(), { ...input, bindingResourceKey: 'inventory' });
    expect(out).toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'missing_dependency' })] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('uses a same-company binding as the existing target', async () => {
    const { writer, writeFromIntegration } = setup({ change: 'updated' });
    const ctx = context({
      resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'asset', targetId: ids.asset, companyId: ids.company }),
    });
    const out = await writer.write(ctx, { ...input, bindingResourceKey: 'inventory' });
    expect(out.change).toBe('updated');
    expect(writeFromIntegration).toHaveBeenCalledWith(expect.objectContaining({ existingTargetId: ids.asset }));
  });

  it('returns a bounded validation gap for malformed input', async () => {
    const { writer, writeFromIntegration } = setup();
    expect(() => writer.validate({ ...input, name: '' })).toThrow();
    const out = await writer.write(context(), { ...input, name: '' });
    expect(out).toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation', details: { reasonCode: 'invalid_input' } })] });
    expect(JSON.stringify(out)).not.toContain('ZodError');
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('blocks a source identity collision before writing', async () => {
    const { writer, writeFromIntegration } = setup();
    const ctx = context({ previousProvenance: {
      integrationId: ids.integration, externalOrgId: 'other-org', resourceKey: 'devices', externalId: input.externalId,
      sourceRevision: null, sourceFingerprint: null, firstSeenAt: '2026-07-01T00:00:00.000Z', lastSeenAt: '2026-07-01T00:00:00.000Z',
      lastSyncedAt: '2026-07-01T00:00:00.000Z', ownership: 'breeze', state: 'active',
    } });
    const out = await writer.write(ctx, input);
    expect(out).toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'ambiguous' })] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('preserves rejected manual ownership and source identity across retries', async () => {
    const { writer, writeFromIntegration } = setup();
    const manual = {
      integrationId: ids.integration,
      externalOrgId: 'manual-org',
      resourceKey: 'manual-assets',
      externalId: 'manual-org:manual-assets:asset-1',
      sourceRevision: 'manual-7',
      sourceFingerprint: 'manual-fingerprint',
      firstSeenAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-01T00:00:00.000Z',
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
      ownership: 'weavestream' as const,
      state: 'active' as const,
    };
    const first = await writer.write(context({ previousProvenance: manual }), input);
    expect(first).toMatchObject({
      change: 'blocked',
      provenance: {
        ownership: 'weavestream',
        externalOrgId: manual.externalOrgId,
        resourceKey: manual.resourceKey,
        externalId: manual.externalId,
      },
    });
    const second = await writer.write(
      context({ previousProvenance: first.provenance }),
      input,
    );
    expect(second).toMatchObject({
      change: 'blocked',
      provenance: { ownership: 'weavestream', externalId: manual.externalId },
    });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('preserves service-computed manual ownership checksums', async () => {
    const { writer, writeFromIntegration } = setup({ change: 'unchanged', fieldChecksums: { [ids.field]: 'manual-checksum' } });
    const out = await writer.write(context({ previousFieldChecksums: { [ids.field]: 'prior-checksum' } }), input);
    expect(out.fieldChecksums).toEqual({ [ids.field]: 'manual-checksum' });
    expect(writeFromIntegration).toHaveBeenCalledWith(expect.objectContaining({ previousFieldChecksums: { [ids.field]: 'prior-checksum' } }));
  });

  it('returns sanitized bounded provenance without raw field values', async () => {
    const { writer } = setup();
    const out = await writer.write(context(), input);
    expect(out.provenance).toEqual(expect.objectContaining({ externalId: input.externalId, sourceRevision: '7', firstSeenAt: '2026-07-13T18:00:00.000Z', ownership: 'breeze' }));
    expect(JSON.stringify(out.provenance)).not.toContain('edge-01');
    expect(Buffer.byteLength(JSON.stringify(out.provenance), 'utf8')).toBeLessThanOrEqual(8192);
  });

  it('rejects nested secret material before calling the native asset port', async () => {
    const { writer, writeFromIntegration } = setup();
    const out = await writer.write(context(), {
      ...input,
      fieldValues: [{ ...input.fieldValues[0]!, value: { accessToken: 'short' } }],
    });
    expect(out).toMatchObject({
      change: 'blocked',
      gaps: [{ details: { reasonCode: 'sensitive_input' } }],
    });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('blocks an arbitrary existing target without matching Breeze provenance', async () => {
    const { writer, writeFromIntegration } = setup({ change: 'updated' });
    const out = await writer.write(context({ existingTargetId: ids.asset, previousProvenance: null }), input);
    expect(out).toMatchObject({ change: 'blocked', gaps: [{ details: { reasonCode: 'manual_ownership' } }] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it.each([
    ['cyclic', () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
    ['too deep', () => {
      let value: Record<string, unknown> = {};
      const root = value;
      for (let index = 0; index < 9; index += 1) {
        const child: Record<string, unknown> = {};
        value.child = child;
        value = child;
      }
      return root;
    }],
    ['too many entries', () => Object.fromEntries(
      Array.from({ length: 1_025 }, (_, index) => [`field${index}`, index]),
    )],
  ] as const)('blocks %s field JSON before validation with the safe sentinel', async (_label, makeValue) => {
    const { writer, writeFromIntegration } = setup();
    const out = await writer.write(context(), {
      ...input,
      fieldValues: [{ ...input.fieldValues[0]!, value: makeValue() }],
    });
    expect(out).toMatchObject({
      change: 'blocked',
      gaps: [{ kind: 'validation', details: { reasonCode: 'input_bounds_exceeded' } }],
    });
    expect(out.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('blocks throwing array access without exposing source text', async () => {
    const value: unknown[] = [];
    Object.defineProperty(value, 0, {
      enumerable: true,
      get: () => { throw new Error('source-secret-index-text'); },
    });
    const { writer, writeFromIntegration } = setup();
    const out = await writer.write(context(), {
      ...input,
      fieldValues: [{ ...input.fieldValues[0]!, value }],
    });
    expect(out).toMatchObject({
      change: 'blocked',
      gaps: [{ details: { reasonCode: 'input_bounds_exceeded' } }],
    });
    expect(JSON.stringify(out)).not.toContain('source-secret-index-text');
    expect(out.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });
});
