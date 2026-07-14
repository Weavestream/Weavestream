import { RelationTargetWriter, type RelationIntegrationWritePort } from './relation-target.writer.js';
import type { ReconstructionWriteContext, RelationReconstructionInput } from './reconstruction-target.js';

const ids = {
  company: '30000000-0000-0000-0000-000000000001', otherCompany: '30000000-0000-0000-0000-000000000002',
  integration: '30000000-0000-0000-0000-000000000003', mapping: '30000000-0000-0000-0000-000000000004',
  resource: '30000000-0000-0000-0000-000000000005', actor: '30000000-0000-0000-0000-000000000006',
  relation: '30000000-0000-0000-0000-000000000007', sourceAsset: '30000000-0000-0000-0000-000000000008',
  targetArticle: '30000000-0000-0000-0000-000000000009',
};

const input: RelationReconstructionInput = {
  targetKind: 'relation', externalId: 'org-1:relations:device-procedure',
  source: { externalOrgId: 'org-1', resourceKey: 'relations', sourceId: 'device-procedure' },
  sourceRef: { resourceKey: 'devices', externalId: 'org-1:devices:edge-01' },
  targetRef: { resourceKey: 'procedures', externalId: 'org-1:procedures:rebuild-edge-01' },
  relationType: 'rebuild-procedure',
};

function context(overrides: Partial<ReconstructionWriteContext> = {}): ReconstructionWriteContext {
  const resolveBinding = jest.fn(async (ref: { resourceKey: string }) =>
    ref.resourceKey === 'devices'
      ? { targetKind: 'asset' as const, targetId: ids.sourceAsset, companyId: ids.company }
      : { targetKind: 'article' as const, targetId: ids.targetArticle, companyId: ids.company },
  );
  return {
    companyId: ids.company, integrationId: ids.integration, integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource, resourceKey: 'relations', externalOrgId: 'org-1', auditActorId: ids.actor,
    now: new Date('2026-07-13T18:00:00.000Z'), dryRun: false, resolveBinding, ...overrides,
  };
}

function setup(result: Partial<Awaited<ReturnType<RelationIntegrationWritePort['writeFromIntegration']>>> = {}) {
  const writeFromIntegration = jest.fn().mockResolvedValue({ targetId: ids.relation, companyId: ids.company, change: 'created', ...result });
  return { writer: new RelationTargetWriter({ writeFromIntegration }), writeFromIntegration };
}

describe('RelationTargetWriter', () => {
  it('resolves endpoints in one company and calls the idempotent relation service', async () => {
    const { writer, writeFromIntegration } = setup();
    const out = await writer.write(context(), input);
    expect(out).toMatchObject({ targetKind: 'relation', targetId: ids.relation, change: 'created' });
    expect(writeFromIntegration).toHaveBeenCalledWith(expect.objectContaining({ companyId: ids.company, sourceType: 'Asset', sourceId: ids.sourceAsset, targetType: 'Article', targetId: ids.targetArticle, relationType: input.relationType }));
  });

  it.each(['updated', 'unchanged'] as const)('returns %s from the native idempotent service', async (change) => {
    const { writer } = setup({ change });
    await expect(writer.write(context({ existingTargetId: ids.relation }), input)).resolves.toMatchObject({ change });
  });

  it('marks a stale relation binding restored after an idempotent write', async () => {
    const { writer } = setup({ change: 'unchanged' });
    await expect(writer.write(context({ existingTargetId: ids.relation, existingState: 'stale' }), input)).resolves.toMatchObject({ change: 'restored' });
  });

  it('blocks existing or endpoint targets from another company', async () => {
    const { writer } = setup({ companyId: ids.otherCompany, change: 'updated' });
    await expect(writer.write(context({ existingTargetId: ids.relation }), input)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
    const crossEndpoint = context({ resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'asset', targetId: ids.sourceAsset, companyId: ids.otherCompany }) });
    await expect(writer.write(crossEndpoint, input)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
  });

  it('blocks either missing dependency without calling the relation service', async () => {
    const { writer, writeFromIntegration } = setup();
    const missing = context({ resolveBinding: jest.fn().mockResolvedValue(null) });
    await expect(writer.write(missing, input)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'missing_dependency' })] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('rejects invalid relation types and unsupported endpoint kinds safely', async () => {
    const { writer, writeFromIntegration } = setup();
    await expect(writer.write(context(), { ...input, relationType: '' })).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
    const unsupported = context({ resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'subnet', targetId: ids.sourceAsset, companyId: ids.company }) });
    await expect(writer.write(unsupported, input)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'unsupported' })] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('blocks source identity collisions and manual composite ownership', async () => {
    const previous = { integrationId: ids.integration, externalOrgId: 'other', resourceKey: 'relations', externalId: input.externalId, sourceRevision: null, sourceFingerprint: null, firstSeenAt: '2026-07-01T00:00:00.000Z', lastSeenAt: '2026-07-01T00:00:00.000Z', lastSyncedAt: '2026-07-01T00:00:00.000Z', ownership: 'breeze' as const, state: 'active' as const };
    const { writer, writeFromIntegration } = setup();
    await expect(writer.write(context({ previousProvenance: previous }), input)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'ambiguous' })] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
    const manual = setup({ targetId: ids.relation, change: 'blocked', gap: { kind: 'ambiguous', message: 'A manual relation owns this composite key.', details: { reasonCode: 'manual_ownership' } } }).writer;
    await expect(manual.write(context(), input)).resolves.toMatchObject({ gaps: [expect.objectContaining({ kind: 'ambiguous' })] });
  });

  it('returns bounded provenance without relation endpoint data', async () => {
    const { writer } = setup();
    const out = await writer.write(context(), input);
    expect(out.provenance.externalId).toBe(input.externalId);
    expect(JSON.stringify(out.provenance)).not.toContain(ids.sourceAsset);
    expect(Buffer.byteLength(JSON.stringify(out.provenance))).toBeLessThanOrEqual(8192);
  });
});
