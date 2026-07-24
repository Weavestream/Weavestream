import { CompanyExportDataService } from './company-export-data.service.js';
import { assetFieldChecksum } from '../assets/assets.service.js';

const ids = {
  company: '00000000-0000-4000-8000-000000000001',
  otherCompany: '00000000-0000-4000-8000-000000000002',
  integration: '00000000-0000-4000-8000-000000000003',
  mapping: '00000000-0000-4000-8000-000000000004',
  resource: '00000000-0000-4000-8000-000000000005',
  subnetA: '00000000-0000-4000-8000-000000000006',
  subnetB: '00000000-0000-4000-8000-000000000007',
  reservation: '00000000-0000-4000-8000-000000000008',
  assetA: '00000000-0000-4000-8000-000000000009',
  assetB: '00000000-0000-4000-8000-000000000010',
  article: '00000000-0000-4000-8000-000000000011',
  relation: '00000000-0000-4000-8000-000000000012',
  syncA: '00000000-0000-4000-8000-000000000013',
  syncB: '00000000-0000-4000-8000-000000000014',
  otherMapping: '00000000-0000-4000-8000-000000000015',
  otherResource: '00000000-0000-4000-8000-000000000016',
};

const BLOCKED_SECRET = 'ghp_distinctiveBlockedSecretValue1234567890';
const NOW = new Date('2026-07-14T12:00:00.000Z');

describe('CompanyExportDataService reconstruction export', () => {
  it('gathers deterministic company-scoped IPAM, relations, safe gaps, and provenance', async () => {
    const { prisma, service, crypto } = setup();
    const interfacesValue = 'ID: 11111111-1111-4111-8111-111111111111 | Name: Ethernet 0 | MAC: 00:11:22:33:44:55 | Primary: yes';
    const addressesValue = 'ID: 22222222-2222-4222-8222-222222222222 | Interface ID: 11111111-1111-4111-8111-111111111111 | Interface: Ethernet 0 | Address: 10.20.30.10 | Family: IPv4 | Assignment: static | Reservation eligible: yes | Subnet mask: 255.255.255.0 | Active: yes | First seen: 2026-07-14T00:00:00.000Z | Deactivated: —';
    prisma.subnet.findMany.mockResolvedValueOnce([
      subnet(ids.subnetB, 'Zeta VLAN', '10.30.0.0/24'),
      subnet(ids.subnetA, 'Core Network', '10.20.30.0/24'),
    ]);
    prisma.ipReservation.findMany.mockResolvedValueOnce([
      {
        id: ids.reservation,
        companyId: ids.company,
        subnetId: ids.subnetA,
        ipAddress: '10.20.30.10',
        label: 'APP-01 static',
        notes: 'Reserved for the application server',
        subnet: { companyId: ids.company },
      },
    ]);
    prisma.assetFieldValue.findMany.mockResolvedValueOnce([
      {
        id: 'field-value-equipment',
        companyId: ids.company,
        value: '10.20.30.99',
        assetId: ids.assetA,
        assetFieldId: 'field-address',
        asset: { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
        assetField: { name: 'Address', slug: 'address', fieldType: 'IP_ADDRESS' },
      },
      {
        id: 'field-value-interfaces',
        companyId: ids.company,
        assetId: ids.assetA,
        assetFieldId: 'field-interfaces',
        value: interfacesValue,
        asset: { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
        assetField: { name: 'Interfaces', slug: 'interfaces', fieldType: 'TEXTAREA' },
      },
      {
        id: 'field-value-addresses',
        companyId: ids.company,
        assetId: ids.assetA,
        assetFieldId: 'field-network-addresses',
        value: addressesValue,
        asset: { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
        assetField: { name: 'Network Address History', slug: 'network-addresses', fieldType: 'TEXTAREA' },
      },
    ]);
    prisma.relation.findMany.mockResolvedValueOnce([
      relation(ids.relation, ids.assetB, ids.assetA, 'depends_on'),
      relation('00000000-0000-4000-8000-000000000099', ids.assetA, ids.article, 'rebuild_procedure', 'Article'),
      relation('00000000-0000-4000-8000-000000000098', ids.assetA, '00000000-0000-4000-8000-000000000097', 'cross_company'),
    ]);
    prisma.asset.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
      { id: ids.assetB, companyId: ids.company, name: 'SW-01' },
    ]);
    prisma.article.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { id: ids.article, companyId: ids.company, title: 'APP-01 Rebuild Procedure' },
    ]);

    prisma.integrationReconstructionSummary.findMany.mockResolvedValueOnce([
      summary('network-interfaces', '00000000-0000-4000-8000-000000000030'),
      summary('devices', '00000000-0000-4000-8000-000000000029'),
    ]);
    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce(
      [
        'synchronization_error',
        'secret_blocked',
        'unsupported',
        'validation',
        'missing_dependency',
        'ambiguous',
      ].map((kind, index) => gap(kind, index)),
    );
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([
      syncRecord({ id: ids.syncB, state: 'stale', targetId: ids.assetB, targetName: 'SW-01' }),
      syncRecord({
        id: ids.syncA,
        state: 'active',
        targetId: ids.assetA,
        targetName: 'APP-01',
        fieldChecksums: {
          'field-interfaces': assetFieldChecksum(interfacesValue),
          'field-network-addresses': assetFieldChecksum(addressesValue),
        },
      }),
    ]);

    const result = await service.gather(ids.company, { includePasswords: false });
    const serialized = JSON.stringify(result);

    expect(result.includePasswords).toBe(false);
    expect(crypto.decrypt).not.toHaveBeenCalled();
    expect(result.ipam.map((item: { name: string }) => item.name)).toEqual([
      'Core Network',
      'Zeta VLAN',
    ]);
    expect(result.ipam[0]).toMatchObject({
      cidr: '10.20.30.0/24',
      reservations: [{ ipAddress: '10.20.30.10', label: 'APP-01 static' }],
      occupants: [
        { ipAddress: '10.20.30.10', assetLabel: 'APP-01', interfaceLabel: 'Ethernet 0' },
      ],
    });
    expect(result.relations).toEqual([
      expect.objectContaining({
        relationType: 'depends_on',
        source: expect.objectContaining({ label: 'SW-01' }),
        target: expect.objectContaining({ label: 'APP-01' }),
      }),
      expect.objectContaining({
        relationType: 'rebuild_procedure',
        source: expect.objectContaining({ label: 'APP-01' }),
        target: expect.objectContaining({ label: 'APP-01 Rebuild Procedure' }),
      }),
    ]);
    expect(result.reconstruction.summaries.map((row: { resourceKey: string }) => row.resourceKey))
      .toEqual(['devices', 'network-interfaces']);
    expect(result.reconstruction.gaps.map((row: { kind: string }) => row.kind)).toEqual([
      'ambiguous',
      'missing_dependency',
      'secret_blocked',
      'synchronization_error',
      'unsupported',
      'validation',
    ]);
    expect(result.reconstruction.gaps.find((row: { kind: string }) => row.kind === 'secret_blocked'))
      .toMatchObject({ message: 'A secret blocked item requires operator review.' });
    expect(result.reconstruction.provenance.map((row: { target: { label: string } }) => row.target.label))
      .toEqual(['APP-01', 'SW-01']);
    expect(result.reconstruction.provenance[1]).toMatchObject({
      sourceLabel: 'Breeze',
      sourceResource: 'devices',
      ownership: 'breeze',
      state: 'stale',
      staleSince: new Date('2026-07-14T11:00:00.000Z'),
    });

    expect(serialized).not.toContain(BLOCKED_SECRET);
    expect(serialized).not.toContain('raw-upstream-org-id');
    expect(serialized).not.toContain('externalOrgId');
    expect(serialized).not.toContain('sourceFingerprint');
    expect(serialized).not.toContain('sourceRevision');
    expect(serialized).not.toContain('rawPayload');
    expect(serialized).not.toContain('details');
    expect(serialized).not.toContain('cross_company');
    expect(serialized).not.toContain('10.20.30.99');
    expect(serialized).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(serialized).not.toContain('22222222-2222-4222-8222-222222222222');

    expect(prisma.subnet.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: ids.company }),
    }));
    expect(prisma.ipReservation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: ids.company }),
    }));
    expect(prisma.assetFieldValue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        companyId: ids.company,
        assetField: { slug: { in: ['interfaces', 'network-addresses'] } },
      }),
    }));
    expect(prisma.relation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: ids.company }),
    }));
    expect(prisma.integrationReconstructionSummary.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ companyId: ids.company }) }),
    );
    expect(prisma.integrationReconstructionGap.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ companyId: ids.company }) }),
    );
    expect(prisma.integrationSyncRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ companyId: ids.company }) }),
    );
    expect(prisma.password.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.not.objectContaining({
        passwordCiphertext: expect.anything(),
        notesCiphertext: expect.anything(),
        totpSecretCiphertext: expect.anything(),
      }),
    }));
  });

  it('keeps plaintext password decryption an explicit caller opt-in', async () => {
    const { prisma, service, crypto } = setup();
    prisma.password.findMany.mockResolvedValueOnce([{
      id: '00000000-0000-4000-8000-000000000040',
      name: 'Manual admin', username: 'admin', url: null, tags: [],
      lastRotatedAt: null, expiresAt: null, pwnedCount: null, folder: null,
      passwordCiphertext: 'password-cipher', notesCiphertext: null,
      totpSecretCiphertext: null,
    }]);
    crypto.decrypt.mockReturnValueOnce('manually-managed-password');

    const result = await service.gather(ids.company, { includePasswords: true });

    expect(result.includePasswords).toBe(true);
    expect(result.passwords[0]?.password).toBe('manually-managed-password');
    expect(crypto.decrypt).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['mapping company', ids.otherCompany, ids.integration],
    ['resource integration', ids.company, '00000000-0000-4000-8000-000000000099'],
  ])('fails closed when a reconstruction %s scope is inconsistent', async (
    _label,
    mappingCompanyId,
    resourceIntegrationId,
  ) => {
    const { prisma, service } = setup();
    prisma.integrationReconstructionSummary.findMany.mockResolvedValueOnce([{
      ...summary('devices', '00000000-0000-4000-8000-000000000050'),
      companyMapping: {
        companyId: mappingCompanyId,
        integrationId: ids.integration,
      },
      resource: { integrationId: resourceIntegrationId, resourceKey: 'devices' },
    }]);

    await expect(service.gather(ids.company, { includePasswords: false }))
      .rejects.toThrow(/inconsistent reconstruction export scope/i);
  });

  it('omits foreign native targets from gaps and provenance instead of leaking their labels', async () => {
    const { prisma, service } = setup();
    const foreignTarget = {
      ...syncRecord({
        id: ids.syncA,
        state: 'active',
        targetId: ids.assetA,
        targetName: 'FOREIGN-TARGET-LABEL',
      }),
      asset: { id: ids.assetA, companyId: ids.otherCompany, name: 'FOREIGN-TARGET-LABEL' },
    };
    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce([{
      ...gap('missing_dependency', 0),
      syncRecord: foreignTarget,
    }]);
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([foreignTarget]);

    const result = await service.gather(ids.company, { includePasswords: false });

    expect(result.reconstruction.gaps[0]?.target).toBeNull();
    expect(result.reconstruction.provenance).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('FOREIGN-TARGET-LABEL');
  });

  it.each([
    ['same-company different mapping', ids.otherMapping, ids.resource],
    ['same mapping different resource', ids.mapping, ids.otherResource],
  ])('fails closed for a gap target bound through %s', async (
    _label,
    integrationCompanyMappingId,
    resourceId,
  ) => {
    const { prisma, service } = setup();
    const mismatched = {
      ...syncRecord({ id: ids.syncA, state: 'active', targetId: ids.assetA, targetName: 'DO-NOT-LEAK' }),
      integrationCompanyMappingId,
      resourceId,
    };
    prisma.integrationReconstructionGap.findMany.mockResolvedValueOnce([{
      ...gap('missing_dependency', 0),
      syncRecord: mismatched,
    }]);
    // The mismatched row is attached to this gap only; it is not a valid
    // independently selected provenance row for this export fixture.
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([]);

    const result = await service.gather(ids.company, { includePasswords: false });

    expect(result.reconstruction.gaps[0]?.target).toBeNull();
    expect(JSON.stringify(result)).not.toContain('DO-NOT-LEAK');
    expect(JSON.stringify(result)).not.toContain(`/assets/${ids.assetA}`);
  });

  it('projects synchronized Breeze assets and managed articles without source identifiers', async () => {
    const { prisma, service } = setup();
    const interfaceId = '11111111-1111-4111-8111-111111111111';
    const addressId = '22222222-2222-4222-8222-222222222222';
    // CR-022: modern UUID versions (v6-v8) must redact like v1-v5 —
    // upstream sources mint v7 ids, and these sit in a non-identifier
    // cell so the token regex, not the key filter, must catch them.
    const modernSourceIds = [
      '33333333-3333-6333-8333-333333333333',
      '018f6b1e-7c1a-7abc-9def-0123456789ab',
      '44444444-4444-8444-a444-444444444444',
    ];
    const revision = 'distinctive-source-revision-abc123';
    const interfacesValue = `ID: ${interfaceId} | Name: Ethernet 0 | MAC: 00:11:22:33:44:55 | Primary: yes | Notes: uplinks ${modernSourceIds.join(' then ')}`;
    const addressesValue = `ID: ${addressId} | Interface ID: ${interfaceId} | Interface: Ethernet 0 | Address: 10.20.30.10 | Family: IPv4 | Assignment: static | Reservation eligible: yes | Active: yes`;
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([
      syncRecord({
        id: ids.syncA,
        state: 'active',
        targetId: ids.assetA,
        targetName: 'APP-01',
        fieldChecksums: {
          'field-interfaces': assetFieldChecksum(interfacesValue),
          'field-network-addresses': assetFieldChecksum(addressesValue),
        },
      }),
      syncRecordForArticle(ids.article, 'APP-01 Offline Procedure', 'active'),
    ]);
    prisma.asset.findMany.mockResolvedValueOnce([assetRow(ids.assetA, null, [
      fieldValue('Breeze ID', 'breeze-id', 'TEXT', ids.assetA, 0),
      fieldValue('Source Revision', 'source-revision', 'TEXT', revision, 1),
      fieldValue('Interfaces', 'interfaces', 'TEXTAREA', interfacesValue, 2),
      fieldValue('Network Address History', 'network-addresses', 'TEXTAREA', addressesValue, 3),
      fieldValue('Recovery role', 'recovery-role', 'TEXT', 'Primary application server', 4),
      fieldValue('Recovery dependency', 'recovery-dependency', 'ASSET_REFERENCE', [ids.assetB], 5),
    ])]).mockResolvedValueOnce([
      { id: ids.assetB, name: 'DB-01 readable dependency' },
    ]);
    prisma.article.findMany.mockResolvedValueOnce([{
      id: ids.article,
      title: 'APP-01 Offline Procedure',
      editorMode: 'markdown',
      content: null,
      markdownSource: `<!-- weavestream:breeze:managed:start -->\n# Rebuild APP-01\nInstall Windows Server from verified media.\nPolicy UUID: ${ids.assetA}\n## Source provenance\nSource UUID: ${ids.article}\nSource revision: ${revision}\nSource fingerprint: distinctive-fingerprint\nExported source date: 2026-07-14T00:00:00.000Z\n<!-- weavestream:breeze:managed:end -->`,
      contentPlaintext: `Rebuild APP-01\nInstall Windows Server from verified media.\nSource UUID: ${ids.article}\nSource revision: ${revision}`,
      updatedAt: NOW,
      archivedAt: null,
      folder: { name: 'Runbooks' },
    }]);

    const result = await service.gather(ids.company, { includePasswords: false });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain('Primary application server');
    expect(serialized).toContain('DB-01 readable dependency');
    expect(serialized).toContain('Ethernet 0');
    expect(serialized).toContain('10.20.30.10');
    expect(serialized).toContain('Install Windows Server from verified media.');
    expect(serialized).toContain('Last synchronized');
    expect(serialized).toContain('Breeze');
    expect(serialized).toContain('uplinks');
    for (const raw of [interfaceId, addressId, ...modernSourceIds, revision, 'distinctive-fingerprint', 'Source UUID', 'Source revision', 'Source fingerprint', 'weavestream:breeze:managed']) {
      expect(serialized).not.toContain(raw);
    }
    // WS-CR-019: the operator-curated reference field is not integration
    // data — it keeps its stored ids plus the readable-label lookup
    // (identical treatment to reference fields on unsynchronized assets).
    expect(result.assets[0]?.fields.find((field) => field.label === 'Recovery dependency'))
      .toEqual({
        label: 'Recovery dependency',
        fieldType: 'ASSET_REFERENCE',
        value: [ids.assetB],
        referenceLabels: { [ids.assetB]: 'DB-01 readable dependency' },
      });
  });

  it('includes only stale-bound archived reconstruction records and labels topology last-known stale', async () => {
    const { prisma, service } = setup();
    const staleArticle = '00000000-0000-4000-8000-000000000081';
    const unrelatedArticle = '00000000-0000-4000-8000-000000000082';
    const staleRelation = '00000000-0000-4000-8000-000000000083';
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([
      syncRecord({ id: ids.syncA, state: 'stale', targetId: ids.assetA, targetName: 'ARCHIVED-APP' }),
      syncRecordForArticle(staleArticle, 'Archived recovery procedure', 'stale'),
      syncRecordForSubnet(ids.subnetA, 'Archived recovery subnet'),
      syncRecordForRelation(staleRelation),
    ]);
    prisma.asset.findMany.mockResolvedValueOnce([assetRow(ids.assetA, NOW, [])]);
    prisma.article.findMany.mockResolvedValueOnce([
      { id: staleArticle, title: 'Archived recovery procedure', editorMode: 'markdown', content: null, markdownSource: 'Last-known offline recovery steps', contentPlaintext: 'Last-known offline recovery steps', updatedAt: NOW, archivedAt: NOW, folder: null },
      { id: unrelatedArticle, title: 'UNRELATED MANUAL ARCHIVE', editorMode: 'markdown', content: null, markdownSource: 'must not export', contentPlaintext: 'must not export', updatedAt: NOW, archivedAt: NOW, folder: null },
    ]);
    prisma.subnet.findMany.mockResolvedValueOnce([
      { ...subnet(ids.subnetA, 'Archived recovery subnet', '10.20.30.0/24'), archivedAt: NOW },
      { ...subnet(ids.subnetB, 'UNRELATED MANUAL SUBNET', '10.40.0.0/24'), archivedAt: NOW },
    ]);
    prisma.relation.findMany.mockResolvedValueOnce([
      relation(staleRelation, ids.assetA, staleArticle, 'rebuild_procedure', 'Article'),
    ]);
    prisma.asset.findMany.mockResolvedValueOnce([
      { id: ids.assetA, companyId: ids.company, name: 'ARCHIVED-APP', archivedAt: NOW },
    ]);
    prisma.article.findMany.mockResolvedValueOnce([
      { id: staleArticle, companyId: ids.company, title: 'Archived recovery procedure', archivedAt: NOW },
    ]);

    const result = await service.gather(ids.company, { includePasswords: false });
    const serialized = JSON.stringify(result);

    expect(result.assets[0]).toMatchObject({ name: 'APP-01', reconstructionState: { state: 'stale' } });
    expect(result.articles[0]).toMatchObject({ title: 'Archived recovery procedure', reconstructionState: { state: 'stale' } });
    expect(result.ipam[0]).toMatchObject({ name: 'Archived recovery subnet', reconstructionState: { state: 'stale' } });
    expect(result.relations[0]).toMatchObject({ reconstructionState: { state: 'stale' } });
    expect(serialized).toContain('Last-known offline recovery steps');
    expect(serialized).not.toContain('UNRELATED MANUAL');
    expect(serialized).not.toContain(unrelatedArticle);
  });

  it.each([
    ['single exact /24 reservation', ['24'], 1],
    ['two reservations disambiguated by /24 mask', ['16', '24'], 1],
    ['two reservations with inconsistent /25 mask', ['16', '24'], 0],
  ])('keeps occupant proof subnet-exact for %s', async (
    _label,
    reservationPrefixes,
    expectedOccupants,
  ) => {
    const { prisma, service } = setup();
    const subnet16 = '00000000-0000-4000-8000-000000000091';
    const subnet24 = '00000000-0000-4000-8000-000000000092';
    const mask = expectedOccupants === 0 ? '255.255.255.128' : '255.255.255.0';
    const interfacesValue = 'ID: 11111111-1111-4111-8111-111111111111 | Name: Ethernet 0 | MAC: 00:11:22:33:44:55 | Primary: yes';
    const addressesValue = `ID: 22222222-2222-4222-8222-222222222222 | Interface ID: 11111111-1111-4111-8111-111111111111 | Interface: Ethernet 0 | Address: 10.20.30.10 | Family: IPv4 | Assignment: static | Reservation eligible: yes | Subnet mask: ${mask} | Active: yes`;
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([
      syncRecord({
        id: ids.syncA,
        state: 'active',
        targetId: ids.assetA,
        targetName: 'APP-01',
        fieldChecksums: {
          'field-interfaces': assetFieldChecksum(interfacesValue),
          'field-network-addresses': assetFieldChecksum(addressesValue),
        },
      }),
    ]);
    prisma.subnet.findMany.mockResolvedValueOnce([
      { ...subnet(subnet16, 'Campus /16', '10.20.0.0/16'), prefix: 16, archivedAt: null },
      { ...subnet(subnet24, 'Application /24', '10.20.30.0/24'), prefix: 24, archivedAt: null },
    ]);
    prisma.ipReservation.findMany.mockResolvedValueOnce(
      reservationPrefixes.map((prefix, index) => ({
        id: `00000000-0000-4000-8000-${String(93 + index).padStart(12, '0')}`,
        companyId: ids.company,
        subnetId: prefix === '16' ? subnet16 : subnet24,
        ipAddress: '10.20.30.10',
        label: `APP-01 reservation /${prefix}`,
        notes: null,
        subnet: { companyId: ids.company },
      })),
    );
    prisma.assetFieldValue.findMany.mockResolvedValueOnce([
      {
        id: 'interfaces', companyId: ids.company, assetId: ids.assetA,
        assetFieldId: 'field-interfaces',
        value: interfacesValue,
        asset: { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
        assetField: { name: 'Interfaces', slug: 'interfaces', fieldType: 'TEXTAREA' },
      },
      {
        id: 'addresses', companyId: ids.company, assetId: ids.assetA,
        assetFieldId: 'field-network-addresses',
        value: addressesValue,
        asset: { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
        assetField: { name: 'Network Address History', slug: 'network-addresses', fieldType: 'TEXTAREA' },
      },
    ]);

    const result = await service.gather(ids.company, { includePasswords: false });
    const subnet16Result = result.ipam.find((row) => row.prefix === 16)!;
    const subnet24Result = result.ipam.find((row) => row.prefix === 24)!;
    const allOccupants = result.ipam.flatMap((row) => row.occupants);

    expect(allOccupants).toHaveLength(expectedOccupants);
    expect(subnet16Result.occupants).toEqual([]);
    expect(subnet24Result.occupants).toHaveLength(expectedOccupants);
    expect(JSON.stringify(allOccupants)).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(JSON.stringify(allOccupants)).not.toContain('22222222-2222-4222-8222-222222222222');
  });

  it.each([
    ['weavestream-owned Breeze binding', 'breeze', 'weavestream'],
    ['non-Breeze driver binding', 'other-driver', 'breeze'],
  ])('preserves authored projection-like content for a %s', async (
    _label,
    driver,
    ownership,
  ) => {
    const { prisma, service } = setup();
    const authoredUuid = '33333333-3333-4333-8333-333333333333';
    const assetBinding = withBindingAuthority(
      syncRecord({ id: ids.syncA, state: 'active', targetId: ids.assetA, targetName: 'Authored Asset' }),
      driver,
      ownership,
    );
    const articleBinding = withBindingAuthority(
      syncRecordForArticle(ids.article, 'Authored Article', 'active'),
      driver,
      ownership,
    );
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([assetBinding, articleBinding]);
    prisma.asset.findMany.mockResolvedValueOnce([assetRow(ids.assetA, null, [
      fieldValue('Breeze ID', 'breeze-id', 'TEXT', authoredUuid, 0),
      fieldValue('Authored notes', 'authored-notes', 'TEXTAREA', `ID: ${authoredUuid} | Procedure: preserve this text`, 1),
    ])]);
    const authoredArticle = `# Authored procedure\nKeep ${authoredUuid}\n## Source provenance\nThis heading is authored and must remain.`;
    prisma.article.findMany.mockResolvedValueOnce([{
      id: ids.article, title: 'Authored Article', editorMode: 'markdown', content: null,
      markdownSource: authoredArticle, contentPlaintext: authoredArticle,
      updatedAt: NOW, archivedAt: null, folder: null,
    }]);

    const result = await service.gather(ids.company, { includePasswords: false });
    const serialized = JSON.stringify(result);

    expect(serialized).toContain(authoredUuid);
    expect(serialized).toContain('Breeze ID');
    expect(serialized).toContain('## Source provenance');
    expect(serialized).toContain('This heading is authored and must remain.');
  });

  it('exports operator-authored values on synchronized assets verbatim', async () => {
    const { prisma, service } = setup();
    const manualUuid = '44444444-4444-4444-8444-444444444444';
    const manualNotes = 'Uplink A | Uplink B | verify failover order after maintenance';
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([
      syncRecord({ id: ids.syncA, state: 'active', targetId: ids.assetA, targetName: 'APP-01' }),
    ]);
    prisma.asset.findMany.mockResolvedValueOnce([assetRow(ids.assetA, null, [
      fieldValue('Deployment notes', 'deployment-notes', 'TEXTAREA', manualNotes, 0),
      fieldValue('Warranty reference', 'warranty-reference', 'TEXT', `Contract ${manualUuid}`, 1),
    ])]);

    const result = await service.gather(ids.company, { includePasswords: false });

    // WS-CR-019: fields the integration does not manage are operator
    // data — never parsed as projection text, omitted, or identifier-
    // stripped, even though the asset itself is Breeze-bound.
    expect(result.assets[0]?.fields).toEqual([
      { label: 'Deployment notes', fieldType: 'TEXTAREA', value: manualNotes },
      { label: 'Warranty reference', fieldType: 'TEXT', value: `Contract ${manualUuid}` },
    ]);
  });

  it('exports operator-edited synchronized fields verbatim and never mints occupants from them', async () => {
    const { prisma, service } = setup();
    const interfaceId = '11111111-1111-4111-8111-111111111111';
    const addressId = '22222222-2222-4222-8222-222222222222';
    const syncedInterfaces = `ID: ${interfaceId} | Name: Ethernet 0 | MAC: 00:11:22:33:44:55 | Primary: yes`;
    const syncedAddresses = `ID: ${addressId} | Interface ID: ${interfaceId} | Interface: Ethernet 0 | Address: 10.20.30.10 | Family: IPv4 | Assignment: static | Reservation eligible: yes | Subnet mask: 255.255.255.0 | Active: yes`;
    const editedInterfaces = `${syncedInterfaces} | Operator note: replaced NIC`;
    const editedAddresses = `${syncedAddresses} | Operator note: readdressed by hand`;
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([
      syncRecord({
        id: ids.syncA,
        state: 'active',
        targetId: ids.assetA,
        targetName: 'APP-01',
        fieldChecksums: {
          'field-interfaces': assetFieldChecksum(syncedInterfaces),
          'field-network-addresses': assetFieldChecksum(syncedAddresses),
        },
      }),
    ]);
    prisma.asset.findMany.mockResolvedValueOnce([assetRow(ids.assetA, null, [
      fieldValue('Interfaces', 'interfaces', 'TEXTAREA', editedInterfaces, 0),
    ])]);
    prisma.subnet.findMany.mockResolvedValueOnce([
      subnet(ids.subnetA, 'Core Network', '10.20.30.0/24'),
    ]);
    prisma.ipReservation.findMany.mockResolvedValueOnce([
      {
        id: ids.reservation,
        companyId: ids.company,
        subnetId: ids.subnetA,
        ipAddress: '10.20.30.10',
        label: 'APP-01 static',
        notes: null,
        subnet: { companyId: ids.company },
      },
    ]);
    prisma.assetFieldValue.findMany.mockResolvedValueOnce([
      {
        id: 'edited-interfaces', companyId: ids.company, assetId: ids.assetA,
        assetFieldId: 'field-interfaces',
        value: editedInterfaces,
        asset: { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
        assetField: { name: 'Interfaces', slug: 'interfaces', fieldType: 'TEXTAREA' },
      },
      {
        id: 'edited-addresses', companyId: ids.company, assetId: ids.assetA,
        assetFieldId: 'field-network-addresses',
        value: editedAddresses,
        asset: { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
        assetField: { name: 'Network Address History', slug: 'network-addresses', fieldType: 'TEXTAREA' },
      },
    ]);

    const result = await service.gather(ids.company, { includePasswords: false });

    // The recorded checksum no longer matches: the operator owns these
    // bytes now. They export unmodified, and structured inventory is
    // never reconstructed from them.
    expect(result.assets[0]?.fields).toEqual([
      { label: 'Interfaces', fieldType: 'TEXTAREA', value: editedInterfaces },
    ]);
    expect(result.ipam.flatMap((row) => row.occupants)).toEqual([]);
  });

  it('keeps sanitizing mapped synchronized fields until authorship is recorded', async () => {
    const { prisma, service } = setup();
    const interfaceId = '11111111-1111-4111-8111-111111111111';
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([
      syncRecord({
        id: ids.syncA,
        state: 'active',
        targetId: ids.assetA,
        targetName: 'APP-01',
        fieldMappings: [{ targetFieldId: 'field-interfaces', syncDirection: 'source_wins' }],
      }),
    ]);
    prisma.asset.findMany.mockResolvedValueOnce([assetRow(ids.assetA, null, [
      fieldValue('Interfaces', 'interfaces', 'TEXTAREA', `ID: ${interfaceId} | Name: Ethernet 0`, 0),
    ])]);

    const result = await service.gather(ids.company, { includePasswords: false });

    // A mapped field with no recorded checksum (legacy sync row) has
    // unknown authorship — it fails closed to the sanitized projection
    // until the next sync records field-level proof.
    expect(result.assets[0]?.fields).toEqual([
      { label: 'Interfaces', fieldType: 'TEXTAREA', value: 'Name: Ethernet 0' },
    ]);
    expect(JSON.stringify(result)).not.toContain(interfaceId);
  });

  it('never treats manual_only mapped fields as integration-managed', async () => {
    const { prisma, service } = setup();
    // manual_only mappings are dormant: the writer never records a
    // checksum for them, so the "unproven → sanitize" legacy window
    // would never close. They must classify as operator data.
    const maintenanceWindow = 'Sat 22:00-02:00 | Sun 04:00-06:00';
    prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([
      syncRecord({
        id: ids.syncA,
        state: 'active',
        targetId: ids.assetA,
        targetName: 'APP-01',
        fieldMappings: [
          { targetFieldId: 'field-maintenance-window', syncDirection: 'manual_only' },
        ],
      }),
    ]);
    prisma.asset.findMany.mockResolvedValueOnce([assetRow(ids.assetA, null, [
      fieldValue('Maintenance window', 'maintenance-window', 'TEXTAREA', maintenanceWindow, 0),
    ])]);

    const result = await service.gather(ids.company, { includePasswords: false });

    expect(result.assets[0]?.fields).toEqual([
      { label: 'Maintenance window', fieldType: 'TEXTAREA', value: maintenanceWindow },
    ]);
  });

  it('derives Breeze projection and stale state deterministically from all mixed bindings', async () => {
    const run = async (reverseIds: boolean) => {
      const { prisma, service } = setup();
      const active = syncRecord({
        id: reverseIds ? 'ffffffff-ffff-4fff-8fff-ffffffffffff' : '00000000-0000-4000-8000-000000000021',
        state: 'active', targetId: ids.assetA, targetName: 'APP-01',
      });
      const stale = syncRecord({
        id: reverseIds ? '00000000-0000-4000-8000-000000000021' : 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        state: 'stale', targetId: ids.assetA, targetName: 'APP-01',
      });
      active.companyMapping.integration.name = 'Alpha Breeze';
      stale.companyMapping.integration.name = 'Zulu Breeze';
      prisma.integrationSyncRecord.findMany.mockResolvedValueOnce([stale, active]);
      prisma.asset.findMany.mockResolvedValueOnce([assetRow(ids.assetA, null, [
        fieldValue('Breeze ID', 'breeze-id', 'TEXT', ids.assetA, 0),
        fieldValue('Recovery role', 'recovery-role', 'TEXT', 'Readable recovery server', 1),
      ])]);
      const result = await service.gather(ids.company, { includePasswords: false });
      return {
        asset: result.assets[0],
        provenance: result.reconstruction.provenance,
      };
    };

    const first = await run(false);
    const reversed = await run(true);

    expect(first).toEqual(reversed);
    expect(first.asset?.reconstructionState).toBeUndefined();
    expect(JSON.stringify(first.asset)).not.toContain(ids.assetA);
    expect(JSON.stringify(first.asset)).toContain('Readable recovery server');
    expect(first.provenance).toHaveLength(2);
  });

  it('rejects bounded export overflow instead of silently truncating', async () => {
    const { prisma, service } = setup();
    prisma.subnet.findMany.mockResolvedValueOnce(
      Array.from({ length: 10_001 }, (_, index) =>
        subnet(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `Subnet ${index}`, '10.0.0.0/24')),
    );

    await expect(service.gather(ids.company, { includePasswords: false }))
      .rejects.toThrow(/subnets exceeded the bounded export limit/i);
  });

  it('reports breezeIntegrationActive from an enabled, non-disabled breeze mapping', async () => {
    const { prisma, service } = setup();

    const inactive = await service.gather(ids.company, { includePasswords: false });
    expect(inactive.breezeIntegrationActive).toBe(false);
    // Scoped to THIS company's enabled mappings on a live breeze driver
    // — the query is the authorization boundary, not post-filtering.
    expect(prisma.integrationCompanyMapping.findFirst).toHaveBeenCalledWith({
      where: {
        companyId: ids.company,
        enabled: true,
        integration: { driver: 'breeze', status: { not: 'DISABLED' } },
      },
      select: { id: true },
    });

    prisma.integrationCompanyMapping.findFirst.mockResolvedValueOnce({ id: ids.mapping });
    const active = await service.gather(ids.company, { includePasswords: false });
    expect(active.breezeIntegrationActive).toBe(true);
  });
});

function setup() {
  const prisma = {
    systemSetting: { findUnique: jest.fn().mockResolvedValue({ workspaceName: 'MSP Workspace' }) },
    company: { findUnique: jest.fn().mockResolvedValue(company()) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    asset: { findMany: jest.fn().mockResolvedValue([]) },
    assetFieldValue: { findMany: jest.fn().mockResolvedValue([]) },
    tag: { findMany: jest.fn().mockResolvedValue([]) },
    article: { findMany: jest.fn().mockResolvedValue([]) },
    password: { findMany: jest.fn().mockResolvedValue([]) },
    monitoredDomain: { findMany: jest.fn().mockResolvedValue([]) },
    upload: { findMany: jest.fn().mockResolvedValue([]) },
    subnet: { findMany: jest.fn().mockResolvedValue([]) },
    ipReservation: { findMany: jest.fn().mockResolvedValue([]) },
    relation: { findMany: jest.fn().mockResolvedValue([]) },
    integrationReconstructionSummary: { findMany: jest.fn().mockResolvedValue([]) },
    integrationReconstructionGap: { findMany: jest.fn().mockResolvedValue([]) },
    integrationSyncRecord: { findMany: jest.fn().mockResolvedValue([]) },
    integrationCompanyMapping: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const crypto = { decrypt: jest.fn() };
  const service = new CompanyExportDataService(prisma as never, crypto as never);
  return { prisma, crypto, service };
}

function company() {
  return {
    id: ids.company, name: 'Acme', slug: 'acme', type: 'CUSTOMER', quickNotes: null,
    contactName: null, contactTitle: null, contactEmail: null, contactPhone: null,
    generalEmail: null, phone: null, fax: null, website: null, addressLine1: null,
    addressLine2: null, city: null, region: null, postalCode: null, country: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'), parent: null,
  };
}

function subnet(id: string, name: string, cidr: string) {
  return {
    id, companyId: ids.company, name, cidr, prefix: 24, vlanId: 20,
    gateway: cidr.replace('0/24', '1'), dhcpRangeStart: null, dhcpRangeEnd: null,
    description: `${name} description`,
  };
}

function assetRow(id: string, archivedAt: Date | null, fieldValues: ReturnType<typeof fieldValue>[]) {
  return {
    id,
    companyId: ids.company,
    name: id === ids.assetA ? 'APP-01' : 'Asset',
    archivedAt,
    assetLayout: { name: 'Device Inventory' },
    fieldValues,
  };
}

function fieldValue(
  name: string,
  slug: string,
  fieldType: string,
  value: unknown,
  position: number,
) {
  return {
    assetFieldId: `field-${slug}`,
    value,
    assetField: { name, slug, fieldType, position },
  };
}

function relation(
  id: string,
  sourceId: string,
  targetId: string,
  relationType: string,
  targetType = 'Asset',
) {
  return {
    id, companyId: ids.company, sourceType: 'Asset', sourceId,
    targetType, targetId, relationType, createdAt: NOW,
  };
}

const counts = {
  synchronizedCurrent: 1,
  manuallyDocumented: 2,
  secretBlocked: 3,
  missing: 4,
  stale: 5,
  synchronizationError: 6,
};

function summary(resourceKey: string, id: string) {
  return {
    id, companyId: ids.company, integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource, counts, evaluatedAt: NOW,
    lastSuccessfulSyncAt: new Date('2026-07-14T11:59:00.000Z'),
    companyMapping: {
      companyId: ids.company, integrationId: ids.integration,
      externalOrgId: 'raw-upstream-org-id', externalOrgName: 'Raw upstream tenant',
    },
    resource: { integrationId: ids.integration, resourceKey },
  };
}

function gap(kind: string, index: number) {
  const secret = kind === 'secret_blocked';
  return {
    id: `00000000-0000-4000-8000-${String(60 + index).padStart(12, '0')}`,
    companyId: ids.company,
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    kind,
    message: secret ? `Blocked inline token ${BLOCKED_SECRET}` : `Safe ${kind} message`,
    details: { rawPayload: BLOCKED_SECRET, sourceId: 'raw-source-id' },
    firstSeenAt: new Date('2026-07-14T10:00:00.000Z'),
    lastSeenAt: new Date('2026-07-14T11:00:00.000Z'),
    resolvedAt: null,
    companyMapping: { companyId: ids.company, integrationId: ids.integration },
    resource: { integrationId: ids.integration, resourceKey: 'devices' },
    syncRecord: null,
  };
}

function syncRecord(input: {
  id: string;
  state: 'active' | 'stale';
  targetId: string;
  targetName: string;
  fieldChecksums?: Record<string, string>;
  fieldMappings?: Array<{ targetFieldId: string | null; syncDirection: string }>;
}) {
  const stale = input.state === 'stale';
  return {
    id: input.id,
    companyId: ids.company,
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    targetKind: 'asset',
    assetId: input.targetId,
    subnetId: null,
    ipReservationId: null,
    articleId: null,
    relationId: null,
    state: input.state,
    staleSince: stale ? new Date('2026-07-14T11:00:00.000Z') : null,
    lastSyncedFieldChecksums: input.fieldChecksums ?? {},
    provenance: {
      integrationId: ids.integration,
      externalOrgId: 'raw-upstream-org-id',
      resourceKey: 'devices',
      externalId: `raw-external-${input.id}`,
      sourceRevision: 'raw-revision',
      sourceFingerprint: 'raw-fingerprint',
      firstSeenAt: '2026-07-13T10:00:00.000Z',
      lastSeenAt: '2026-07-14T10:00:00.000Z',
      lastSyncedAt: '2026-07-14T10:01:00.000Z',
      ownership: 'breeze',
      state: input.state,
    },
    asset: { id: input.targetId, companyId: ids.company, name: input.targetName },
    subnet: null,
    ipReservation: null,
    article: null,
    relation: null,
    companyMapping: {
      companyId: ids.company,
      integration: { id: ids.integration, name: 'Breeze', driver: 'breeze' },
    },
    resource: {
      integrationId: ids.integration,
      resourceKey: 'devices',
      fieldMappings: input.fieldMappings ?? [],
    },
  };
}

function syncRecordForArticle(
  articleId: string,
  title: string,
  state: 'active' | 'stale',
) {
  const base = syncRecord({ id: `${articleId.slice(0, -1)}a`, state, targetId: ids.assetA, targetName: 'unused' });
  return {
    ...base,
    targetKind: 'article',
    assetId: null,
    articleId,
    asset: null,
    article: { id: articleId, companyId: ids.company, title },
    resource: { integrationId: ids.integration, resourceKey: 'knowledge-articles', fieldMappings: [] },
    provenance: { ...base.provenance, resourceKey: 'knowledge-articles' },
  };
}

function syncRecordForSubnet(subnetId: string, name: string) {
  const base = syncRecord({ id: `${subnetId.slice(0, -1)}b`, state: 'stale', targetId: ids.assetA, targetName: 'unused' });
  return {
    ...base,
    targetKind: 'subnet',
    assetId: null,
    subnetId,
    asset: null,
    subnet: { id: subnetId, companyId: ids.company, name },
    resource: { integrationId: ids.integration, resourceKey: 'network-segments', fieldMappings: [] },
    provenance: { ...base.provenance, resourceKey: 'network-segments' },
  };
}

function syncRecordForRelation(relationId: string) {
  const base = syncRecord({ id: `${relationId.slice(0, -1)}c`, state: 'stale', targetId: ids.assetA, targetName: 'unused' });
  return {
    ...base,
    targetKind: 'relation',
    assetId: null,
    relationId,
    asset: null,
    relation: { id: relationId, companyId: ids.company },
    resource: { integrationId: ids.integration, resourceKey: 'relations', fieldMappings: [] },
    provenance: { ...base.provenance, resourceKey: 'relations' },
  };
}

function withBindingAuthority<T extends {
  companyMapping: { integration: { driver: string } };
  provenance: { ownership: string };
}>(
  record: T,
  driver: string,
  ownership: string,
): T {
  record.companyMapping.integration.driver = driver;
  record.provenance.ownership = ownership;
  return record;
}
