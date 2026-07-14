import { ArticleTargetWriter, type ArticleIntegrationWritePort } from './article-target.writer.js';
import type { ArticleReconstructionInput, ReconstructionWriteContext } from './reconstruction-target.js';

const ids = {
  company: '20000000-0000-0000-0000-000000000001', otherCompany: '20000000-0000-0000-0000-000000000002',
  integration: '20000000-0000-0000-0000-000000000003', mapping: '20000000-0000-0000-0000-000000000004',
  resource: '20000000-0000-0000-0000-000000000005', actor: '20000000-0000-0000-0000-000000000006',
  article: '20000000-0000-0000-0000-000000000007', folder: '20000000-0000-0000-0000-000000000008',
};

const input: ArticleReconstructionInput = {
  targetKind: 'article', externalId: 'org-1:procedures:script-1',
  source: { externalOrgId: 'org-1', resourceKey: 'procedures', sourceId: 'script-1', revision: '42', fingerprint: 'sha256:body' },
  title: 'Rebuild edge-01', slug: 'rebuild-edge-01', folderId: ids.folder,
  markdown: '# Rebuild\n\n1. Install the agent.', visibleToClients: false,
};

function context(overrides: Partial<ReconstructionWriteContext> = {}): ReconstructionWriteContext {
  const ctx: ReconstructionWriteContext = {
    companyId: ids.company, integrationId: ids.integration, integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource, resourceKey: 'procedures', externalOrgId: 'org-1', auditActorId: ids.actor,
    now: new Date('2026-07-13T18:00:00.000Z'), dryRun: false,
    resolveBinding: jest.fn().mockResolvedValue(null), ...overrides,
  };
  if (ctx.existingTargetId && overrides.previousProvenance === undefined) {
    ctx.previousProvenance = {
      integrationId: ids.integration, externalOrgId: 'org-1', resourceKey: 'procedures', externalId: input.externalId,
      sourceRevision: '42', sourceFingerprint: 'sha256:body', firstSeenAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-01T00:00:00.000Z', lastSyncedAt: '2026-07-01T00:00:00.000Z',
      ownership: 'breeze', state: ctx.existingState === 'stale' ? 'stale' : 'active',
    };
  }
  return ctx;
}

function setup(result: Partial<Awaited<ReturnType<ArticleIntegrationWritePort['writeFromIntegration']>>> = {}) {
  const writeFromIntegration = jest.fn().mockResolvedValue({ targetId: ids.article, companyId: ids.company, change: 'created', ...result });
  return { writer: new ArticleTargetWriter({ writeFromIntegration }), writeFromIntegration };
}

describe('ArticleTargetWriter', () => {
  it('creates a source-owned Markdown article and published version through the native service', async () => {
    const { writer, writeFromIntegration } = setup();
    const out = await writer.write(context(), input);
    expect(out).toMatchObject({ targetKind: 'article', targetId: ids.article, change: 'created' });
    expect(writeFromIntegration).toHaveBeenCalledWith(expect.objectContaining({ companyId: ids.company, auditActorId: ids.actor, integrationId: ids.integration, markdown: input.markdown, slug: input.slug }));
  });

  it.each(['updated', 'unchanged'] as const)('returns %s for a bound source article', async (change) => {
    const { writer } = setup({ change });
    await expect(writer.write(context({ existingTargetId: ids.article }), input)).resolves.toMatchObject({ change });
  });

  it('reports restored when a stale source-owned binding is successfully reused', async () => {
    const { writer } = setup({ change: 'unchanged' });
    await expect(writer.write(context({ existingTargetId: ids.article, existingState: 'stale' }), input)).resolves.toMatchObject({ change: 'restored' });
  });

  it('blocks wrong-company targets', async () => {
    const { writer } = setup({ companyId: ids.otherCompany, change: 'updated' });
    await expect(writer.write(context({ existingTargetId: ids.article }), input)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
  });

  it('returns a missing dependency gap when the configured folder is unavailable', async () => {
    const { writer } = setup({ targetId: '', change: 'blocked', gap: { kind: 'missing_dependency', message: 'Article folder was not found.', details: { reasonCode: 'dependency_not_found' } } });
    await expect(writer.write(context(), input)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'missing_dependency' })] });
  });

  it('rejects malformed deterministic slugs and source input without leaking Markdown', async () => {
    const { writer, writeFromIntegration } = setup();
    expect(() => writer.validate({ ...input, slug: 'Not deterministic' })).toThrow();
    const out = await writer.write(context(), { ...input, slug: 'Not deterministic' });
    expect(out).toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
    expect(JSON.stringify(out)).not.toContain('Install the agent');
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('blocks a mismatched previous source identity', async () => {
    const previous = { integrationId: ids.integration, externalOrgId: 'org-1', resourceKey: 'other', externalId: input.externalId, sourceRevision: null, sourceFingerprint: null, firstSeenAt: '2026-07-01T00:00:00.000Z', lastSeenAt: '2026-07-01T00:00:00.000Z', lastSyncedAt: '2026-07-01T00:00:00.000Z', ownership: 'breeze' as const, state: 'active' as const };
    const { writer, writeFromIntegration } = setup();
    await expect(writer.write(context({ previousProvenance: previous }), input)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'ambiguous' })] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('never overwrites an unbound manual article on slug collision', async () => {
    const { writer } = setup({ targetId: ids.article, change: 'blocked', gap: { kind: 'ambiguous', message: 'An unbound article already owns this slug.', details: { reasonCode: 'manual_ownership', candidateCount: 1 } } });
    const out = await writer.write(context(), input);
    expect(out).toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'ambiguous', details: expect.objectContaining({ reasonCode: 'manual_ownership' }) })] });
  });

  it('returns bounded source revision/fingerprint provenance without article content', async () => {
    const { writer } = setup();
    const out = await writer.write(context(), input);
    expect(out.provenance).toEqual(expect.objectContaining({ sourceRevision: '42', sourceFingerprint: 'sha256:body', ownership: 'breeze' }));
    expect(JSON.stringify(out.provenance)).not.toContain('Install the agent');
    expect(Buffer.byteLength(JSON.stringify(out.provenance))).toBeLessThanOrEqual(8192);
  });

  it('rejects secret-bearing Markdown before calling the native article port', async () => {
    const { writer, writeFromIntegration } = setup();
    const out = await writer.write(context(), {
      ...input,
      markdown: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
    });
    expect(out).toMatchObject({ gaps: [{ details: { reasonCode: 'sensitive_input' } }] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });

  it('blocks an arbitrary existing article without matching Breeze provenance', async () => {
    const { writer, writeFromIntegration } = setup({ change: 'updated' });
    const out = await writer.write(context({ existingTargetId: ids.article, previousProvenance: null }), input);
    expect(out).toMatchObject({ gaps: [{ details: { reasonCode: 'manual_ownership' } }] });
    expect(writeFromIntegration).not.toHaveBeenCalled();
  });
});
