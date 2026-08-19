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
    expect(result.applied).toBe(true);
    expect(prisma.integrationReconstructionSummary.updateMany).toHaveBeenCalledWith({
      where: {
        companyId: ids.company,
        integrationCompanyMappingId: ids.mapping,
        summaryKey: ids.resource,
        evaluatedAt: { lte: new Date('2026-07-14T12:00:00.000Z') },
      },
      data: expect.objectContaining({
        counts: result.counts,
        evaluatedAt: new Date('2026-07-14T12:00:00.000Z'),
        clearedAt: null,
      }),
    });
    // Lock-order contract: the summary (scope clock) is acquired before
    // any gap write on every completeness path.
    const summaryOrder = prisma.integrationReconstructionSummary.updateMany.mock
      .invocationCallOrder[0]!;
    const firstGapOrder = prisma.$executeRaw.mock.invocationCallOrder[0]!;
    expect(summaryOrder).toBeLessThan(firstGapOrder);
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

  it.each([
    ['blocked relation', 'relation'],
    ['invalid-provenance subnet', 'subnet'],
    ['blocked reservation', 'ip_reservation'],
  ] as const)('does not classify a %s binding as synchronized current', async (_label, targetKind) => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    const record = {
      id: `binding-${targetKind}`, state: targetKind === 'subnet' ? 'active' : 'blocked', targetKind,
      assetId: null,
      articleId: null,
      subnetId: targetKind === 'subnet' ? 'subnet-authority' : null,
      ipReservationId: targetKind === 'ip_reservation' ? 'reservation-authority' : null,
      relationId: targetKind === 'relation' ? 'relation-authority' : null,
      lastSyncedFieldChecksums: {},
      provenance: targetKind === 'subnet'
        ? { ownership: 'weavestream', state: 'active', resourceKey: 'subnets' }
        : { ownership: 'breeze', state: 'blocked', resourceKey: targetKind },
    };
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([record]);
    if (targetKind === 'relation') {
      prisma.relation.findMany.mockResolvedValueOnce([{
        id: 'relation-authority', relationType: 'depends_on',
        sourceType: 'Asset', sourceId: 'asset-a', targetType: 'Article', targetId: 'article-b',
      }]);
    }
    if (targetKind === 'subnet') {
      prisma.subnet.findMany.mockResolvedValueOnce([{
        id: 'subnet-authority', description: 'Required firewall rules', archivedAt: null,
      }]);
    }
    if (targetKind === 'ip_reservation') {
      prisma.ipReservation.findMany.mockResolvedValueOnce([{
        id: 'reservation-authority', notes: 'Firewall allocation',
      }]);
    }

    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());
    const capability = targetKind === 'relation' ? 'service_dependencies' : 'ip_firewall';
    expect(category(result, capability)).toBe('missing');
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

  it('indexes bound targets once instead of rescanning every sync record', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    let relationIdReads = 0;
    const records = Array.from({ length: 400 }, (_, index) => ({
      id: `binding-${String(index).padStart(4, '0')}`,
      state: 'active', targetKind: 'relation', assetId: null, articleId: null,
      subnetId: null, ipReservationId: null,
      get relationId() {
        relationIdReads += 1;
        return `relation-${String(index).padStart(4, '0')}`;
      },
      lastSyncedFieldChecksums: {},
      provenance: sourceProvenance('device-relationships', 'active'),
    }));
    const relations = records.map((record, index) => ({
      id: record.relationId,
      relationType: 'depends_on', sourceType: 'Asset', sourceId: `asset-${index}`,
      targetType: 'Article', targetId: `article-${index}`,
    }));
    relationIdReads = 0;
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce(records);
    prisma.relation.findMany.mockResolvedValueOnce(relations);

    await expect(new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope())).resolves.toBeDefined();

    expect(relationIdReads).toBeLessThanOrEqual(records.length * 5);
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
      activeAssetFields: ['address_line_1'], manualAssetFields: [], staleAssetFields: [],
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

  it('scans a blank-line-padded ordered-actions heading in linear time', async () => {
    // Article bodies are operator-editable and uncapped, and this scan runs
    // inside the sync run's transaction on the API's own event loop. A run of
    // blank lines under the heading with no `1.` must not backtrack: at 60
    // newlines an exponential scan does not terminate.
    const prisma = completenessPrisma({
      activeAssetFields: [], manualAssetFields: [], staleAssetFields: [],
      activeArticles: [{
        resourceKey: 'automations',
        text: `## Ordered actions\n${'\n'.repeat(60)}not a numbered list`,
      }],
      staleArticles: [], gaps: [],
    });
    const startedAt = process.hrtime.bigint();
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    expect(category(result, 'ordered_rebuild_steps')).toBe('missing');
    expect(elapsedMs).toBeLessThan(1_000);
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

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(10);
    for (const [strings, ...values] of prisma.$executeRaw.mock.calls) {
      const sql = (strings as readonly string[]).join('?');
      expect(sql).toContain('ON CONFLICT');
      expect(sql).toContain('WHERE NOT EXISTS');
      expect(values.some((value: unknown) =>
        typeof value === 'string' && /^completeness:[0-9a-f]{64}$/.test(value))).toBe(true);
    }
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
    expect(JSON.stringify(prisma.$executeRaw.mock.calls))
      .not.toMatch(/password|token|secret-value/i);
    expect(JSON.stringify(prisma.integrationReconstructionGap.updateMany.mock.calls))
      .not.toMatch(/password|token|secret-value/i);
  });

  it('skips every gap write when a strictly newer evaluation already holds the scorecard', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    prisma.integrationReconstructionSummary.updateMany.mockResolvedValue({ count: 0 });
    prisma.integrationReconstructionSummary.createMany.mockResolvedValue({ count: 0 });
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());

    expect(result.applied).toBe(false);
    expect(result.counts.missing).toBe(10);
    // guarded write, lost insert race, one guarded retry — then stop
    expect(prisma.integrationReconstructionSummary.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.integrationReconstructionSummary.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    // a stale evaluation must not reopen, refresh, resolve, or create gaps
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.integrationReconstructionGap.updateMany).not.toHaveBeenCalled();
  });

  it('recovers the scorecard through one guarded retry after losing a concurrent insert race', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    prisma.integrationReconstructionSummary.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    prisma.integrationReconstructionSummary.createMany.mockResolvedValue({ count: 0 });
    const result = await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());

    expect(result.applied).toBe(true);
    expect(prisma.integrationReconstructionSummary.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(10);
  });

  it('carries the recency guard on every gap write and retries once after a lost gap insert race', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    prisma.$executeRaw.mockResolvedValue(0);
    await new IntegrationCompletenessService(prisma as never)
      .recalculate(prisma as never, scope());

    const guarded = prisma.integrationReconstructionGap.updateMany.mock.calls
      .filter(([arg]: [{ where: { dedupeKey?: unknown } }]) => typeof arg.where.dedupeKey === 'string');
    expect(guarded).toHaveLength(20);
    for (const [arg] of guarded) {
      expect(arg.where.OR).toEqual([
        { resolvedAt: null, lastSeenAt: { lte: scope().evaluatedAt } },
        { resolvedAt: { lte: scope().evaluatedAt } },
      ]);
      expect(arg.data).toMatchObject({ resolvedAt: null, lastSeenAt: scope().evaluatedAt });
    }
  });

  it('does not replace the last-known-good summary when collection fails', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    prisma.integrationSyncRecord.findMany.mockRejectedValueOnce(new Error('temporary database failure'));
    const service = new IntegrationCompletenessService(prisma as never);

    await expect(service.recalculate(prisma as never, scope())).rejects.toThrow('temporary database failure');
    expect(prisma.integrationReconstructionSummary.updateMany).not.toHaveBeenCalled();
    expect(prisma.integrationReconstructionSummary.createMany).not.toHaveBeenCalled();
    expect(prisma.integrationReconstructionGap.updateMany).not.toHaveBeenCalled();
  });

  it('tombstones the scorecard and resolves completeness gaps for non-participating resources', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    const service = new IntegrationCompletenessService(prisma as never);
    await service.clearNonParticipant(prisma as never, scope());

    // The summary is tombstoned in place (never deleted): `evaluatedAt`
    // must survive as the scope's evaluation clock.
    expect(prisma.integrationReconstructionSummary.updateMany).toHaveBeenCalledWith({
      where: {
        companyId: ids.company,
        integrationCompanyMappingId: ids.mapping,
        summaryKey: ids.resource,
        evaluatedAt: { lte: scope().evaluatedAt },
      },
      data: {
        counts: {},
        evaluatedAt: scope().evaluatedAt,
        lastSuccessfulSyncAt: scope().evaluatedAt,
        clearedAt: scope().evaluatedAt,
      },
    });
    expect(prisma.integrationReconstructionGap.updateMany).toHaveBeenCalledWith({
      where: {
        companyId: ids.company,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        resolvedAt: null,
        dedupeKey: { startsWith: 'completeness:' },
        lastSeenAt: { lte: scope().evaluatedAt },
      },
      data: { resolvedAt: scope().evaluatedAt },
    });
    // Lock-order contract with recalculate: the summary row is acquired
    // before any gap row on every completeness path, so concurrent mixed
    // paths queue on the summary instead of deadlocking.
    const summaryOrder = prisma.integrationReconstructionSummary.updateMany.mock
      .invocationCallOrder[0]!;
    const gapOrder = prisma.integrationReconstructionGap.updateMany.mock
      .invocationCallOrder[0]!;
    expect(summaryOrder).toBeLessThan(gapOrder);
    // Only the scoped scorecard artifacts are touched — no gap creation
    // for a resource that never participates.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('leaves gaps a newer evaluation refreshed untouched when a stale clear replays', async () => {
    const prisma = completenessPrisma({
      activeAssetFields: [], activeArticles: [], manualAssetFields: [],
      staleAssetFields: [], staleArticles: [], gaps: [],
    });
    prisma.integrationReconstructionSummary.updateMany.mockResolvedValue({ count: 0 });
    prisma.integrationReconstructionSummary.createMany.mockResolvedValue({ count: 0 });
    const service = new IntegrationCompletenessService(prisma as never);
    await service.clearNonParticipant(prisma as never, scope());

    expect(prisma.integrationReconstructionSummary.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.integrationReconstructionGap.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
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
      provenance: sourceProvenance('sites', 'active'),
    }] : []),
    ...(input.staleAssetFields.length > 0 ? [{
      id: 'stale-asset-binding', state: 'stale', targetKind: 'asset', assetId: staleAssetId,
      articleId: null, subnetId: null, ipReservationId: null, relationId: null,
      lastSyncedFieldChecksums: staleChecksums,
      provenance: sourceProvenance('sites', 'stale'),
    }] : []),
    ...input.activeArticles.map((entry, index) => ({
      id: `active-article-binding-${index}`, state: 'active', targetKind: 'article', assetId: null,
      articleId: articleId(activeArticleId, index), subnetId: null, ipReservationId: null, relationId: null,
      lastSyncedFieldChecksums: {}, provenance: sourceProvenance(entry.resourceKey, 'active'),
    })),
    ...input.staleArticles.map((entry, index) => ({
      id: `stale-article-binding-${index}`, state: 'stale', targetKind: 'article', assetId: null,
      articleId: articleId(staleArticleId, index), subnetId: null, ipReservationId: null, relationId: null,
      lastSyncedFieldChecksums: {}, provenance: sourceProvenance(entry.resourceKey, 'stale'),
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
      // Fresh-state default: the guarded update finds no row, the raw
      // watermark-guarded insert wins. Race tests override per call.
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    integrationReconstructionSummary: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    // The gap insert path is a raw watermark-guarded statement.
    $executeRaw: jest.fn().mockResolvedValue(1),
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

function sourceProvenance(resourceKey: string, state: 'active' | 'stale') {
  return {
    integrationId: '00000000-0000-4000-8000-000000000099',
    externalOrgId: 'org-1', resourceKey, externalId: `org-1:${resourceKey}:source-1`,
    sourceRevision: null, sourceFingerprint: null,
    firstSeenAt: '2026-07-13T00:00:00.000Z',
    lastSeenAt: '2026-07-14T00:00:00.000Z',
    lastSyncedAt: '2026-07-14T00:00:00.000Z',
    ownership: 'breeze', state,
  };
}
