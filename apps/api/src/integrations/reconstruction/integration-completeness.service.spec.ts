import {
  COMPLETENESS_CAPABILITIES,
  IntegrationCompletenessService,
} from './integration-completeness.service.js';
import { transformBreezeRecord } from '../drivers/breeze/breeze.transforms.js';

const ids = {
  mapping: '00000000-0000-0000-0000-000000000012',
  resource: '00000000-0000-0000-0000-000000000013',
  company: '00000000-0000-0000-0000-000000000014',
};

describe('IntegrationCompletenessService', () => {
  it('classifies all ten checklist capabilities into exactly six product categories', async () => {
    expect(COMPLETENESS_CAPABILITIES).toHaveLength(10);
    const prisma = completenessPrisma({
      activeAssetFields: ['physical-location'],
      activeArticles: [{
        resourceKey: 'scripts',
        text: '## Rebuild-safe content\n```bash\n1. install-package app\n```',
      }],
      manualAssetFields: ['license-activation', 'installation-source', 'physical-location'],
      staleAssetFields: [],
      staleArticles: [{
        resourceKey: 'backup-configurations',
        text: 'Destination UUID: 00000000-0000-4000-8000-000000000099\n## Restore capabilities\n```json\n{"notes":"Restore from the vault.","types":["full"]}\n```',
      }],
      gaps: [
        { capability: 'service_dependencies', kind: 'secret_blocked' },
        { capability: 'post_restoration_validation', kind: 'synchronization_error' },
      ],
    });
    const service = new IntegrationCompletenessService(prisma as never);

    const result = await service.recalculate(prisma as never, {
      companyId: ids.company,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      evaluatedAt: new Date('2026-07-14T12:00:00.000Z'),
    });

    expect(result.counts).toEqual({
      synchronizedCurrent: 2,
      manuallyDocumented: 2,
      secretBlocked: 1,
      missing: 3,
      stale: 1,
      synchronizationError: 1,
    });
    expect(result.items.map((item) => item.capability)).toEqual([...COMPLETENESS_CAPABILITIES]);
    expect(prisma.integrationReconstructionSummary.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { integrationCompanyMappingId_summaryKey: {
        integrationCompanyMappingId: ids.mapping,
        summaryKey: ids.resource,
      } },
      create: expect.objectContaining({ counts: result.counts }),
      update: expect.objectContaining({ counts: result.counts }),
    }));
  });

  it('lets current synchronized evidence win, keeps manual distinct, and never treats stale as current', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: ['physical-location'],
      activeArticles: [],
      manualAssetFields: ['physical-location', 'license-activation'],
      staleAssetFields: [],
      staleArticles: [{
        resourceKey: 'backup-configurations',
        text: 'Destination UUID: 00000000-0000-4000-8000-000000000099\n## Restore capabilities\n```json\n{"notes":"Restore from the vault.","types":["full"]}\n```',
      }],
      gaps: [],
    });
    const service = new IntegrationCompletenessService(prisma as never);
    const result = await service.recalculate(prisma as never, scope());

    expect(result.items.find((item) => item.capability === 'physical_location')?.category)
      .toBe('synchronized_current');
    expect(result.items.find((item) => item.capability === 'license_activation')?.category)
      .toBe('manually_documented');
    expect(result.items.find((item) => item.capability === 'backup_restore')?.category)
      .toBe('stale');
  });

  it('does not let source-managed prose claim capabilities Breeze does not explicitly export', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], manualAssetFields: [], staleAssetFields: [], staleArticles: [],
      activeArticles: [{
        resourceKey: 'backup-configurations',
        text: [
          'Administrative credential reference',
          'License activation',
          'Vendor escalation contact',
          'Restore procedure is not exported and requires manual documentation.',
        ].join('\n'),
      }],
      gaps: [],
    });
    const service = new IntegrationCompletenessService(prisma as never);
    const result = await service.recalculate(prisma as never, scope());
    for (const capability of [
      'administrative_credential', 'license_activation',
      'vendor_escalation_contact', 'backup_restore',
    ] as const) {
      expect(result.items.find((item) => item.capability === capability)?.category).toBe('missing');
    }
  });

  it('ignores an unrelated manual relation outside the exact resource targets', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    prisma.relation.findMany.mockResolvedValueOnce([{
      id: 'manual-relation', relationType: 'depends_on',
      sourceType: 'asset', sourceId: '00000000-0000-0000-0000-000000000099',
      targetType: 'asset', targetId: '00000000-0000-0000-0000-000000000098',
    }]);
    const service = new IntegrationCompletenessService(prisma as never);
    const result = await service.recalculate(prisma as never, scope());
    expect(result.items.find((item) => item.capability === 'service_dependencies')?.category)
      .toBe('missing');
  });

  it('does not credit an unrelated company article to this mapping/resource checklist', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    prisma.article.findMany.mockResolvedValueOnce([{
      id: 'unrelated-article', markdownSource: 'License activation and vendor escalation contact',
      contentPlaintext: '', archivedAt: null,
    }]);
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());
    expect(prisma.article.findMany).not.toHaveBeenCalled();
    expect(category(result, 'license_activation')).toBe('missing');
    expect(category(result, 'vendor_escalation_contact')).toBe('missing');
  });

  it('credits a manual article only when a relation links it to an exact bound target', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: ['physical-location'], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    const linkedArticleId = '00000000-0000-0000-0000-000000000077';
    prisma.relation.findMany.mockResolvedValueOnce([{
      id: 'manual-relation', relationType: 'documents',
      sourceType: 'asset', sourceId: '00000000-0000-0000-0000-000000000021',
      targetType: 'article', targetId: linkedArticleId,
    }]);
    prisma.article.findMany.mockResolvedValueOnce([{
      id: linkedArticleId, markdownSource: 'License activation procedure',
      contentPlaintext: '', archivedAt: null,
    }]);
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());
    expect(category(result, 'license_activation')).toBe('manually_documented');
  });

  it.each([
    ['wrong endpoint type', 'Company', null],
    ['archived article', 'Asset', new Date('2026-07-14T11:00:00.000Z')],
  ] as const)('does not credit a linked manual article with %s', async (_label, sourceType, archivedAt) => {
    const prisma = completenessPrisma({
      activeAssetFields: ['physical-location'], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    const linkedArticleId = '00000000-0000-0000-0000-000000000078';
    prisma.relation.findMany.mockResolvedValueOnce([{
      id: 'manual-relation', relationType: 'documents', sourceType,
      sourceId: '00000000-0000-0000-0000-000000000021',
      targetType: 'Article', targetId: linkedArticleId,
    }]);
    prisma.article.findMany.mockResolvedValueOnce([{
      id: linkedArticleId, markdownSource: 'License activation procedure',
      contentPlaintext: '', archivedAt,
    }]);
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());
    expect(category(result, 'license_activation')).toBe('missing');
  });

  it('preserves operator-authored text when its exact bound source article becomes stale', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [], staleAssetFields: [],
      staleArticles: [{ resourceKey: 'scripts', text: 'source-managed projection' }], gaps: [],
    });
    prisma.article.findMany.mockResolvedValueOnce([{
      id: '00000000-0000-0000-0000-000000000024',
      markdownSource: [
        '<!-- weavestream:breeze:managed:start -->',
        'source-managed projection',
        '<!-- weavestream:breeze:managed:end -->',
        'License activation procedure retained by the operator.',
      ].join('\n'),
      contentPlaintext: '', archivedAt: new Date('2026-07-14T11:00:00.000Z'),
    }]);
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());
    expect(category(result, 'license_activation')).toBe('manually_documented');
  });

  it('paginates 10k-scale sync evidence and chunks target lookups', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    const records = Array.from({ length: 1_001 }, (_, index) => ({
      id: `binding-${String(index).padStart(5, '0')}`,
      state: 'active', targetKind: 'asset',
      assetId: `asset-${String(index).padStart(5, '0')}`,
      articleId: null, subnetId: null, ipReservationId: null, relationId: null,
      lastSyncedFieldChecksums: {},
      provenance: { ownership: 'breeze', state: 'active', resourceKey: 'devices' },
    }));
    prisma.integrationSyncRecord.findMany.mockImplementation(async ({ cursor }: {
      cursor?: { id: string };
    }) => {
      const start = cursor ? records.findIndex((record) => record.id === cursor.id) + 1 : 0;
      return records.slice(start, start + 1_000);
    });

    await expect(new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope())).resolves.toBeDefined();
    expect(prisma.integrationSyncRecord.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.assetFieldValue.findMany).toHaveBeenCalledTimes(3);
    for (const [call] of prisma.assetFieldValue.findMany.mock.calls) {
      expect(call.where.assetId.in.length).toBeLessThanOrEqual(500);
    }
  });

  it('recognizes exact Task 7 rendered scripts, automations, and recommended site address fields', async () => {
    const scriptRecord = transformBreezeRecord('scripts', {
      ...breezeBase('00000000-0000-4000-8000-000000000031'),
      sourceScope: 'organization', name: 'Rebuild app', description: null,
      category: 'rebuild', osTypes: ['linux'], language: 'bash',
      content: '1. install-package app\n2. systemctl enable --now app', parameters: null,
      timeoutSeconds: 300, runAs: 'system', version: 1, exitCodeSeverityMapping: null,
    })[0]!;
    const automationRecord = transformBreezeRecord('automations', {
      ...breezeBase('00000000-0000-4000-8000-000000000032'),
      sourceScope: 'organization', name: 'Rebuild automation', description: null,
      enabled: true, trigger: { kind: 'manual' }, conditions: null,
      actions: [{ type: 'run_script', scriptId: '00000000-0000-4000-8000-000000000031' }],
      onFailure: 'stop', notificationTargets: null,
      dependencies: [{ resource: 'scripts', id: '00000000-0000-4000-8000-000000000031' }],
    })[0]!;
    const siteRecord = transformBreezeRecord('sites', {
      ...breezeBase('00000000-0000-4000-8000-000000000033'),
      name: 'HQ', timezone: 'America/Denver',
      address: {
        line1: '100 Main St', line2: null, city: 'Denver', region: 'CO',
        postalCode: '80202', country: 'US',
      },
      contact: null,
    })[0]!;
    expect(siteRecord.reconstructionInput).toBeUndefined();
    expect(siteRecord.fields?.['addressLine1']).toBe('100 Main St');
    const script = scriptRecord.reconstructionInput;
    const automation = automationRecord.reconstructionInput;
    if (script?.targetKind !== 'article' || automation?.targetKind !== 'article') {
      throw new Error('Expected Task 7 article projections.');
    }
    const prisma = completenessPrisma({
      activeAssetFields: ['address-line-1'], manualAssetFields: [], staleAssetFields: [],
      activeArticles: [
        { resourceKey: 'scripts', text: script.markdown, exact: true },
        { resourceKey: 'automations', text: automation.markdown, exact: true },
      ],
      staleArticles: [], gaps: [],
    });
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());
    expect(category(result, 'physical_location')).toBe('synchronized_current');
    expect(category(result, 'ordered_rebuild_steps')).toBe('synchronized_current');
    expect(category(result, 'service_dependencies')).toBe('synchronized_current');
  });

  it('does not treat Task 7 restore capabilities as a procedure without notes and maps real gap sourceResource', async () => {
    const backupRecord = transformBreezeRecord('backup-configurations', {
      ...breezeBase('00000000-0000-4000-8000-000000000041'),
      sourceScope: 'organization', name: 'Backup', kind: 'profile', description: null,
      active: true, selections: {}, destinationId: '00000000-0000-4000-8000-000000000042',
      schedule: null, retention: null, exclusions: [], restore: { types: ['full'], notes: null },
    })[0]!;
    const backup = backupRecord.reconstructionInput;
    if (backup?.targetKind !== 'article') throw new Error('Expected Task 7 backup article.');
    const prisma = completenessPrisma({
      activeAssetFields: [], manualAssetFields: [], staleAssetFields: [],
      activeArticles: [{ resourceKey: 'backup-configurations', text: backup.markdown, exact: true }],
      staleArticles: [],
      gaps: [
        { sourceResource: 'scripts', kind: 'secret_blocked' },
        { sourceResource: 'backup-configurations', kind: 'synchronization_error' },
      ],
    });
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());
    expect(category(result, 'backup_restore')).toBe('synchronization_error');
    expect(category(result, 'ordered_rebuild_steps')).toBe('secret_blocked');
  });

  it('upserts safe actionable missing gaps and resolves absent completeness gaps after success', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    const service = new IntegrationCompletenessService(prisma as never);
    await service.recalculate(prisma as never, scope());

    expect(prisma.integrationReconstructionGap.upsert).toHaveBeenCalledTimes(10);
    expect(prisma.integrationReconstructionGap.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: ids.company,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        resolvedAt: null,
        dedupeKey: { startsWith: 'completeness:' },
        lastSeenAt: { lt: scope().evaluatedAt },
      }),
    }));
    expect(JSON.stringify(prisma.integrationReconstructionGap.upsert.mock.calls))
      .not.toMatch(/password|token|secret-value/i);
  });

  it('does not replace the last-known-good summary when collection fails', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    prisma.integrationSyncRecord.findMany.mockRejectedValueOnce(new Error('temporary database failure'));
    const service = new IntegrationCompletenessService(prisma as never);

    await expect(service.recalculate(prisma as never, scope())).rejects.toThrow('temporary database failure');
    expect(prisma.integrationReconstructionSummary.upsert).not.toHaveBeenCalled();
    expect(prisma.integrationReconstructionGap.updateMany).not.toHaveBeenCalled();
  });
});

function scope() {
  return {
    companyId: ids.company,
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    evaluatedAt: new Date('2026-07-14T12:00:00.000Z'),
  };
}

function completenessPrisma(input: {
  activeAssetFields: string[];
  activeArticles: Array<{ resourceKey: string; text: string; exact?: boolean }>;
  manualAssetFields: string[];
  staleAssetFields: string[];
  staleArticles: Array<{ resourceKey: string; text: string; exact?: boolean }>;
  gaps: Array<{
    capability?: string;
    sourceResource?: string;
    kind: 'secret_blocked' | 'synchronization_error';
  }>;
}) {
  const activeAssetId = '00000000-0000-0000-0000-000000000021';
  const staleAssetId = '00000000-0000-0000-0000-000000000022';
  const activeArticleId = '00000000-0000-0000-0000-000000000023';
  const staleArticleId = '00000000-0000-0000-0000-000000000024';
  const activeChecksums = Object.fromEntries(input.activeAssetFields.map((_, index) => [`active-field-${index}`, 'checksum']));
  const staleChecksums = Object.fromEntries(input.staleAssetFields.map((_, index) => [`stale-field-${index}`, 'checksum']));
  const records = [
    ...(input.activeAssetFields.length > 0 ? [{
      id: 'active-asset-binding', state: 'active', targetKind: 'asset', assetId: activeAssetId,
      articleId: null, subnetId: null, ipReservationId: null, relationId: null,
      lastSyncedFieldChecksums: activeChecksums,
      provenance: { ownership: 'breeze', state: 'active', resourceKey: 'sites' },
    }] : []),
    ...(input.staleAssetFields.length > 0 ? [{
      id: 'stale-asset-binding', state: 'stale', targetKind: 'asset', assetId: staleAssetId,
      articleId: null, subnetId: null, ipReservationId: null, relationId: null,
      lastSyncedFieldChecksums: staleChecksums,
      provenance: { ownership: 'breeze', state: 'stale', resourceKey: 'sites' },
    }] : []),
    ...input.activeArticles.map((entry, index) => ({
      id: `active-article-binding-${index}`, state: 'active', targetKind: 'article', assetId: null,
      articleId: articleId(activeArticleId, index), subnetId: null, ipReservationId: null, relationId: null,
      lastSyncedFieldChecksums: {}, provenance: {
        ownership: 'breeze', state: 'active', resourceKey: entry.resourceKey,
      },
    })),
    ...input.staleArticles.map((entry, index) => ({
      id: `stale-article-binding-${index}`, state: 'stale', targetKind: 'article', assetId: null,
      articleId: articleId(staleArticleId, index), subnetId: null, ipReservationId: null, relationId: null,
      lastSyncedFieldChecksums: {}, provenance: {
        ownership: 'breeze', state: 'stale', resourceKey: entry.resourceKey,
      },
    })),
  ];
  const fieldValues = [
    ...input.activeAssetFields.map((slug, index) => ({
      assetId: activeAssetId, assetFieldId: `active-field-${index}`, value: 'documented', assetField: { slug },
    })),
    ...input.staleAssetFields.map((slug, index) => ({
      assetId: staleAssetId, assetFieldId: `stale-field-${index}`, value: 'documented', assetField: { slug },
    })),
    ...input.manualAssetFields.map((slug, index) => ({
      assetId: activeAssetId, assetFieldId: `manual-field-${index}`, value: 'documented', assetField: { slug },
    })),
  ];
  return {
    integrationSyncRecord: { findMany: jest.fn().mockResolvedValue(records) },
    integrationReconstructionGap: {
      findMany: jest.fn().mockResolvedValue(input.gaps.map((gap) => ({
        kind: gap.kind,
        details: {
          ...(gap.capability ? { unsupportedCapability: gap.capability } : {}),
          ...(gap.sourceResource ? { sourceResource: gap.sourceResource } : {}),
        },
      }))),
      upsert: jest.fn(),
      updateMany: jest.fn(),
    },
    integrationReconstructionSummary: { upsert: jest.fn() },
    assetFieldValue: {
      findMany: jest.fn().mockResolvedValue(fieldValues),
    },
    article: { findMany: jest.fn().mockResolvedValue([
      ...input.activeArticles.map((entry, index) => ({
        id: articleId(activeArticleId, index),
        markdownSource: entry.exact
          ? entry.text
          : `<!-- weavestream:breeze:managed:start -->\n${entry.text}\n<!-- weavestream:breeze:managed:end -->`,
        contentPlaintext: '', archivedAt: null,
      })),
      ...input.staleArticles.map((entry, index) => ({
        id: articleId(staleArticleId, index),
        markdownSource: entry.exact
          ? entry.text
          : `<!-- weavestream:breeze:managed:start -->\n${entry.text}\n<!-- weavestream:breeze:managed:end -->`,
        contentPlaintext: '', archivedAt: new Date('2026-07-14T12:00:00.000Z'),
      })),
    ]) },
    relation: { findMany: jest.fn().mockResolvedValue([]) },
    ipReservation: { findMany: jest.fn().mockResolvedValue([]) },
    subnet: { findMany: jest.fn().mockResolvedValue([]) },
    password: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function articleId(base: string, index: number): string {
  const tail = Number(base.slice(-4)) + index;
  return `${base.slice(0, -4)}${String(tail).padStart(4, '0')}`;
}

function breezeBase(id: string) {
  return {
    id,
    orgId: '00000000-0000-4000-8000-000000000001',
    siteId: null,
    sourceUpdatedAt: '2026-07-14T10:00:00.000Z',
    revision: 'a'.repeat(64),
  };
}

function category(
  result: { items: Array<{ capability: string; category: string }> },
  capability: string,
): string | undefined {
  return result.items.find((item) => item.capability === capability)?.category;
}
