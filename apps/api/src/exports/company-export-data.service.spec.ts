import { CompanyExportDataService } from './company-export-data.service.js';

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
};

const BLOCKED_SECRET = 'ghp_distinctiveBlockedSecretValue1234567890';
const NOW = new Date('2026-07-14T12:00:00.000Z');

describe('CompanyExportDataService reconstruction export', () => {
  it('gathers deterministic company-scoped IPAM, relations, safe gaps, and provenance', async () => {
    const { prisma, service, crypto } = setup();
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
        id: 'field-value-b',
        companyId: ids.company,
        value: '10.20.30.20',
        assetId: ids.assetB,
        asset: { id: ids.assetB, companyId: ids.company, name: 'SW-01' },
        assetField: { name: 'Management IP', fieldType: 'IP_ADDRESS' },
      },
      {
        id: 'field-value-a',
        companyId: ids.company,
        value: '10.20.30.10',
        assetId: ids.assetA,
        asset: { id: ids.assetA, companyId: ids.company, name: 'APP-01' },
        assetField: { name: 'Ethernet 0', fieldType: 'IP_ADDRESS' },
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
      syncRecord({ id: ids.syncA, state: 'active', targetId: ids.assetA, targetName: 'APP-01' }),
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
        { ipAddress: '10.20.30.20', assetLabel: 'SW-01', interfaceLabel: 'Management IP' },
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

    expect(prisma.subnet.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: ids.company }),
    }));
    expect(prisma.ipReservation.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: ids.company }),
    }));
    expect(prisma.assetFieldValue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: ids.company }),
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

  it('rejects bounded export overflow instead of silently truncating', async () => {
    const { prisma, service } = setup();
    prisma.subnet.findMany.mockResolvedValueOnce(
      Array.from({ length: 10_001 }, (_, index) =>
        subnet(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `Subnet ${index}`, '10.0.0.0/24')),
    );

    await expect(service.gather(ids.company, { includePasswords: false }))
      .rejects.toThrow(/subnets exceeded the bounded export limit/i);
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
    resource: { integrationId: ids.integration, resourceKey: 'devices' },
  };
}
