import { IpamService } from './ipam.service.js';
import { IpReservationTargetWriter } from '../integrations/reconstruction/ipam-target.writer.js';
import type { ReconstructionWriteContext } from '../integrations/reconstruction/reconstruction-target.js';
import { transformBreezeRecord } from '../integrations/drivers/breeze/breeze.transforms.js';
import { IntegrationProvenanceService } from '../integrations/reconstruction/integration-provenance.service.js';

const ids = {
  company: '51000000-0000-0000-0000-000000000001',
  actor: '51000000-0000-0000-0000-000000000002',
  integration: '51000000-0000-0000-0000-000000000003',
  subnet: '51000000-0000-0000-0000-000000000004',
  reservation: '51000000-0000-0000-0000-000000000005',
  mapping: '51000000-0000-0000-0000-000000000006',
  resource: '51000000-0000-0000-0000-000000000007',
  other: '51000000-0000-0000-0000-000000000008',
};

function subnetRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.subnet,
    companyId: ids.company,
    name: 'LAN',
    cidr: '10.0.0.0/24',
    prefix: 24,
    vlanId: null,
    gateway: '10.0.0.1',
    dhcpRangeStart: null,
    dhcpRangeEnd: null,
    description: null,
    archivedAt: null,
    createdBy: ids.actor,
    updatedBy: ids.actor,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function binding(targetKind: 'subnet' | 'ip_reservation', overrides: Record<string, unknown> = {}) {
  const isSubnet = targetKind === 'subnet';
  return {
    integrationCompanyMappingId: ids.mapping, resourceId: ids.resource,
    externalId: isSubnet ? 'org:subnets:lan' : 'org:reservations:printer', companyId: ids.company,
    targetKind, assetId: null, subnetId: isSubnet ? ids.subnet : null,
    ipReservationId: isSubnet ? null : ids.reservation, articleId: null, relationId: null,
    state: 'active',
    companyMapping: { integrationId: ids.integration, externalOrgId: 'org' },
    resource: { integrationId: ids.integration, resourceKey: isSubnet ? 'subnets' : 'reservations' },
    provenance: {
      integrationId: ids.integration, externalOrgId: 'org', resourceKey: isSubnet ? 'subnets' : 'reservations',
      externalId: isSubnet ? 'org:subnets:lan' : 'org:reservations:printer', ownership: 'breeze', state: 'active',
    },
    ...overrides,
  };
}

function fullSubnetProvenance(state: 'active' | 'stale') {
  return {
    integrationId: ids.integration,
    externalOrgId: 'org',
    resourceKey: 'subnets',
    externalId: 'org:subnets:lan',
    sourceRevision: null,
    sourceFingerprint: null,
    firstSeenAt: '2026-07-01T00:00:00.000Z',
    lastSeenAt: '2026-07-01T00:00:00.000Z',
    lastSyncedAt: '2026-07-01T00:00:00.000Z',
    ownership: 'breeze',
    state,
  };
}

function reservationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.reservation,
    companyId: ids.company,
    subnetId: ids.subnet,
    ipAddress: '10.0.0.50',
    label: 'Printer',
    notes: null,
    createdBy: ids.actor,
    updatedBy: ids.actor,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function setup(options: { subnet?: unknown; reservation?: unknown; subnetCollision?: unknown; reservationCollision?: unknown; binding?: unknown; targetBinding?: unknown; auditFails?: boolean } = {}) {
  let committed = false;
  const createdSubnet = subnetRow();
  const createdReservation = reservationRow();
  const tx = {
    subnet: {
      findUnique: jest.fn().mockResolvedValue(options.subnet ?? null),
      findFirst: jest.fn(async ({ where }: { where: { id?: { not?: string } } }) => {
        const candidate = options.subnetCollision as { id?: string } | null | undefined;
        return candidate && candidate.id !== where.id?.not ? candidate : null;
      }),
      create: jest.fn().mockResolvedValue(createdSubnet),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue(options.subnet ?? createdSubnet),
    },
    ipReservation: {
      findUnique: jest.fn().mockResolvedValue(options.reservation ?? null),
      findFirst: jest.fn(async ({ where }: { where: { id?: { not?: string } } }) => {
        const candidate = options.reservationCollision as { id?: string } | null | undefined;
        return candidate && candidate.id !== where.id?.not ? candidate : null;
      }),
      create: jest.fn().mockResolvedValue(createdReservation),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue(options.reservation ?? createdReservation),
    },
    integrationSyncRecord: {
      findUnique: jest.fn().mockResolvedValue(options.binding ?? null),
      findFirst: jest.fn().mockResolvedValue(options.targetBinding ?? null),
      findMany: jest.fn().mockResolvedValue(options.targetBinding ? [options.targetBinding] : []),
      update: jest.fn().mockResolvedValue({}),
    },
    relation: { updateMany: jest.fn(), deleteMany: jest.fn() },
    auditLog: { create: jest.fn() },
    // Tagged-template call (strings array) = the scope watermark lock
    // probe; Prisma.sql-object call = the guarded stale transition,
    // which reports survivors via RETURNING.
    $queryRaw: jest.fn(async (query: readonly string[] | { values?: unknown[] }) => {
      if (Array.isArray(query)) return [{ id: 'watermark-row' }];
      if (!options.binding || typeof options.binding !== 'object') return [];
      const values = (query as { values?: unknown[] }).values;
      const staleSince = values?.find((value) => value instanceof Date) as Date | undefined;
      const current = options.binding as Record<string, any>;
      Object.assign(current, {
        state: 'stale',
        staleSince: staleSince ?? current.staleSince,
        provenance: { ...current.provenance, state: 'stale' },
      });
      return [{
        id: current.id ?? 'binding-row',
        targetKind: current.targetKind,
        assetId: current.assetId ?? null,
        subnetId: current.subnetId ?? null,
        ipReservationId: current.ipReservationId ?? null,
        articleId: current.articleId ?? null,
        relationId: current.relationId ?? null,
      }];
    }),
  };
  const prisma = {
    subnet: {
      findUnique: jest.fn().mockResolvedValue(options.subnet ?? null),
      findFirst: jest.fn(async ({ where }: { where: { id?: { not?: string } } }) => {
        const candidate = options.subnetCollision as { id?: string } | null | undefined;
        return candidate && candidate.id !== where.id?.not ? candidate : null;
      }),
      create: tx.subnet.create,
      updateMany: tx.subnet.updateMany,
      findFirstOrThrow: tx.subnet.findFirstOrThrow,
    },
    ipReservation: {
      findUnique: jest.fn().mockResolvedValue(options.reservation ?? null),
      findFirst: jest.fn(async ({ where }: { where: { id?: { not?: string } } }) => {
        const candidate = options.reservationCollision as { id?: string } | null | undefined;
        return candidate && candidate.id !== where.id?.not ? candidate : null;
      }),
      create: tx.ipReservation.create,
      updateMany: tx.ipReservation.updateMany,
      findFirstOrThrow: tx.ipReservation.findFirstOrThrow,
    },
    integrationSyncRecord: {
      findUnique: jest.fn().mockResolvedValue(options.binding ?? null),
      findFirst: jest.fn().mockResolvedValue(options.targetBinding ?? null),
      findMany: jest.fn().mockResolvedValue(options.targetBinding ? [options.targetBinding] : []),
    },
    $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => {
      const result = await callback(tx);
      committed = true;
      return result;
    }),
  };
  const audit = {
    assertIntegrationActor: jest.fn().mockResolvedValue(undefined),
    logWithClient: options.auditFails
      ? jest.fn().mockRejectedValue(new Error('audit failed'))
      : jest.fn().mockResolvedValue(undefined),
  };
  return { service: new IpamService(prisma as never, audit as never), prisma, audit, tx, wasCommitted: () => committed };
}

const subnetInput = {
  companyId: ids.company,
  integrationId: ids.integration,
  integrationCompanyMappingId: ids.mapping,
  resourceId: ids.resource,
  externalId: 'org:subnets:lan',
  auditActorId: ids.actor,
  dryRun: false,
  name: 'LAN',
  cidr: '10.0.0.42/24',
  gateway: '10.0.0.1',
};

describe('IpamService integration system writes', () => {
  it('writes an eligible adjacent Breeze static-address DTO through the real target writer and service', async () => {
    const orgId = '11111111-1111-4111-8111-111111111111';
    const deviceId = '22222222-2222-4222-8222-222222222222';
    const interfaceId = '33333333-3333-4333-8333-333333333333';
    const addressId = '44444444-4444-4444-8444-444444444444';
    const [record] = transformBreezeRecord('ip-reservations', {
      id: deviceId,
      orgId,
      siteId: null,
      sourceUpdatedAt: '2026-07-14T11:00:00.000Z',
      revision: 'a'.repeat(64),
      subjectType: 'device',
      deviceId,
      hardware: {
        processor: { model: null, cores: null, threads: null },
        memory: { totalMb: null },
        graphics: { model: null },
        motherboard: { manufacturer: null, product: null, version: null },
        firmware: { biosVersion: null },
      },
      disks: [],
      interfaces: [{ id: interfaceId, name: 'Ethernet', macAddress: null, primary: true }],
      addresses: [
        {
          id: addressId,
          interfaceId,
          interfaceName: 'Ethernet',
          address: '10.0.0.50',
          family: 'ipv4',
          assignment: 'static',
          reservationEligible: true,
          subnetMask: '255.255.255.0',
          gateway: '10.0.0.1',
          dnsServers: [],
          active: true,
          firstSeenAt: '2026-01-01T00:00:00.000Z',
          deactivatedAt: null,
        },
      ],
      warranty: null,
      virtualMachines: [],
      collections: {
        disks: { total: 0, included: 0, complete: true, reason: null },
        interfaces: { total: 1, included: 1, complete: true, reason: null },
        addresses: { total: 1, included: 1, complete: true, reason: null },
        virtualMachines: { total: 0, included: 0, complete: true, reason: null },
      },
    });
    const harness = setup({ subnet: subnetRow() });
    const context: ReconstructionWriteContext = {
      tx: harness.tx as never,
      companyId: ids.company,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      resourceKey: 'ip-reservations',
      externalOrgId: orgId,
      auditActorId: ids.actor,
      now: new Date('2026-07-14T12:00:00.000Z'),
      dryRun: false,
      resolveBinding: jest.fn().mockResolvedValue({
        targetKind: 'subnet',
        targetId: ids.subnet,
        companyId: ids.company,
      }),
    };

    const out = await new IpReservationTargetWriter(harness.service).write(
      context,
      record!.reconstructionInput as never,
    );

    expect(out).toMatchObject({
      targetKind: 'ip_reservation',
      targetId: ids.reservation,
      change: 'created',
      provenance: {
        externalId: `${orgId}:ip-reservations:${addressId}`,
      },
    });
    expect(harness.tx.ipReservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyId: ids.company,
        subnetId: ids.subnet,
        ipAddress: '10.0.0.50',
        label: 'Static address 10.0.0.50',
      }),
    });
    expect(harness.audit.logWithClient).toHaveBeenCalledWith(
      harness.tx,
      expect.objectContaining({ actorId: ids.actor, entityId: ids.reservation }),
    );
  });

  it('creates a subnet and its attributed audit row in one transaction', async () => {
    const { service, prisma, audit, tx } = setup();
    await expect(service.writeSubnetFromIntegration(subnetInput)).resolves.toEqual({
      targetId: ids.subnet,
      companyId: ids.company,
      change: 'created',
    });
    expect(audit.assertIntegrationActor).toHaveBeenCalledWith(ids.actor, ids.company);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.logWithClient).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ actorId: ids.actor, after: expect.objectContaining({ integrationId: ids.integration }) }),
    );
  });

  it('aborts a mapping transaction that loses the canonical CIDR create race', async () => {
    const { service, audit, tx, wasCommitted } = setup();
    const unique = Object.assign(new Error('canonical CIDR race'), { code: 'P2002' });
    tx.subnet.create.mockRejectedValue(unique);

    await expect(service.writeSubnetFromIntegration(subnetInput)).rejects.toBe(unique);
    expect(audit.logWithClient).not.toHaveBeenCalled();
    expect(wasCommitted()).toBe(false);
  });

  it('blocks instead of overwriting when the canonical subnet changes mid-write', async () => {
    const { service, audit, tx } = setup({ subnet: subnetRow(), binding: binding('subnet') });
    tx.subnet.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.writeSubnetFromIntegration({
      ...subnetInput,
      existingTargetId: ids.subnet,
      description: 'race description',
      tx: tx as never,
    })).resolves.toMatchObject({
      targetId: ids.subnet,
      change: 'blocked',
      gap: {
        kind: 'synchronization_error',
        details: { reasonCode: 'canonical_write_race' },
      },
    });
    expect(tx.subnet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: ids.subnet,
          name: 'LAN',
          cidr: '10.0.0.0/24',
          vlanId: null,
          gateway: '10.0.0.1',
          description: null,
          archivedAt: null,
        }),
      }),
    );
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary existing subnet before mutation', async () => {
    const { service, tx } = setup({ subnet: subnetRow({ name: 'Manual LAN' }) });
    await expect(service.writeSubnetFromIntegration({
      ...subnetInput,
      existingTargetId: ids.subnet,
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.subnet.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null], ['wrong mapping', binding('subnet', { integrationCompanyMappingId: ids.other })],
    ['wrong resource', binding('subnet', { resourceId: ids.other })], ['wrong external id', binding('subnet', { externalId: 'wrong' })],
    ['wrong kind', binding('subnet', { targetKind: 'article' })], ['wrong id', binding('subnet', { subnetId: ids.other })],
    ['wrong company', binding('subnet', { companyId: 'other-company' })],
    ['blocked', binding('subnet', { state: 'blocked', provenance: { integrationId: ids.integration, ownership: 'breeze', state: 'blocked' } })],
    ['manual', binding('subnet', { provenance: { integrationId: ids.integration, ownership: 'weavestream', state: 'active' } })],
  ])('rejects a %s subnet binding despite a forged legacy flag', async (_label, persistedBinding) => {
    const { service, tx } = setup({ subnet: subnetRow({ name: 'Old LAN' }), binding: persistedBinding });
    await expect(service.writeSubnetFromIntegration({ ...subnetInput, existingTargetId: ids.subnet, ownershipVerified: true, name: 'LAN' } as never))
      .resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.subnet.updateMany).not.toHaveBeenCalled();
  });

  it('keeps dry-run side-effect free while validating the actor', async () => {
    const { service, prisma, audit, tx } = setup();
    await expect(service.writeSubnetFromIntegration({ ...subnetInput, dryRun: true })).resolves.toMatchObject({ change: 'created' });
    expect(audit.assertIntegrationActor).toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.subnet.create).not.toHaveBeenCalled();
  });

  it('rolls back the native create when transactional audit fails', async () => {
    const { service, prisma, wasCommitted } = setup({ auditFails: true });
    await expect(service.writeSubnetFromIntegration(subnetInput)).rejects.toThrow('audit failed');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(wasCommitted()).toBe(false);
  });

  it('creates a reservation with the exact target id and transactional attribution', async () => {
    const { service, audit, tx } = setup({ subnet: subnetRow() });
    await expect(service.writeReservationFromIntegration({
      companyId: ids.company,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      externalId: 'org:reservations:printer',
      auditActorId: ids.actor,
      dryRun: false,
      subnetId: ids.subnet,
      ipAddress: '10.0.0.50',
      label: 'Printer',
    })).resolves.toEqual({ targetId: ids.reservation, companyId: ids.company, change: 'created' });
    expect(audit.logWithClient).toHaveBeenCalledWith(tx, expect.objectContaining({ entityId: ids.reservation }));
  });

  it.each([
    ['unchanged', subnetRow(), 'LAN'],
    ['updated', subnetRow(), 'LAN 2'],
    ['restored', subnetRow({ archivedAt: new Date('2026-07-02T00:00:00.000Z') }), 'LAN'],
  ] as const)('classifies a verified existing subnet as %s', async (change, subnet, name) => {
    const state = change === 'restored' ? 'stale' : 'active';
    const { service } = setup({ subnet, binding: binding('subnet', { state, provenance: { integrationId: ids.integration, externalOrgId: 'org', resourceKey: 'subnets', externalId: 'org:subnets:lan', ownership: 'breeze', state } }) });
    await expect(service.writeSubnetFromIntegration({
      ...subnetInput,
      existingTargetId: ids.subnet,
      name,
    })).resolves.toEqual({ targetId: ids.subnet, companyId: ids.company, change });
  });

  it('restores the same archived subnet without replacing its native identity', async () => {
    const { service, tx } = setup({
      subnet: subnetRow({ archivedAt: new Date('2026-07-02T00:00:00.000Z') }),
      binding: binding('subnet', {
        state: 'stale',
        provenance: {
          integrationId: ids.integration, externalOrgId: 'org', resourceKey: 'subnets',
          externalId: 'org:subnets:lan', ownership: 'breeze', state: 'stale',
        },
      }),
    });

    await expect(service.writeSubnetFromIntegration({
      ...subnetInput, existingTargetId: ids.subnet,
    })).resolves.toEqual({ targetId: ids.subnet, companyId: ids.company, change: 'restored' });
    expect(tx.subnet.create).not.toHaveBeenCalled();
    expect(tx.subnet.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: ids.subnet,
        companyId: ids.company,
        archivedAt: new Date('2026-07-02T00:00:00.000Z'),
      }),
      data: expect.objectContaining({ archivedAt: null, cidr: '10.0.0.0/24' }),
    }));
  });

  it('preserves native identity and manual dependent relations across a real stale sweep and restore', async () => {
    const target = subnetRow();
    const persistedBinding = binding('subnet', {
      id: 'binding-shared-subnet',
      staleSince: null,
      lastSeenAt: new Date('2026-07-01T00:00:00.000Z'),
      provenance: fullSubnetProvenance('active'),
    });
    const manualRelations = [{ id: 'relation-manual', subnetId: ids.subnet }];
    const { service, prisma, audit, tx } = setup({ subnet: target, binding: persistedBinding });
    tx.integrationSyncRecord.findMany
      .mockResolvedValueOnce([persistedBinding])
      .mockResolvedValueOnce([]);
    tx.integrationSyncRecord.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(persistedBinding, data);
      return persistedBinding;
    });
    tx.subnet.updateMany.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(target, data);
      return { count: 1 };
    });
    tx.relation.updateMany.mockImplementation(async () => {
      const count = manualRelations.length;
      manualRelations.splice(0);
      return { count };
    });
    tx.relation.deleteMany.mockImplementation(async () => {
      const count = manualRelations.length;
      manualRelations.splice(0);
      return { count };
    });

    const staleAt = new Date('2026-07-14T12:00:00.000Z');
    await expect(new IntegrationProvenanceService(prisma as never, audit as never).staleUnseen(
      tx as never,
      {
        companyId: ids.company,
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        targetKind: 'subnet',
        snapshotAt: staleAt,
        auditActorId: ids.actor,
      },
    )).resolves.toEqual({ stale: 1, archived: 1 });
    expect(target.archivedAt).toEqual(staleAt);

    await expect(service.writeSubnetFromIntegration({
      ...subnetInput,
      existingTargetId: ids.subnet,
    })).resolves.toEqual({ targetId: ids.subnet, companyId: ids.company, change: 'restored' });

    expect(target.id).toBe(ids.subnet);
    expect(target.archivedAt).toBeNull();
    expect(target.cidr).toBe('10.0.0.0/24');
    expect(manualRelations).toEqual([{ id: 'relation-manual', subnetId: ids.subnet }]);
    expect(tx.subnet.create).not.toHaveBeenCalled();
    expect(tx.relation.updateMany).not.toHaveBeenCalled();
    expect(tx.relation.deleteMany).not.toHaveBeenCalled();
  });

  it('updates native subnet facts through one stable UUID-backed source binding', async () => {
    const externalId = 'org:subnets:11111111-1111-4111-8111-111111111111';
    const { service, tx } = setup({
      subnet: subnetRow(),
      binding: binding('subnet', {
        externalId,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'subnets',
          externalId,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(
      service.writeSubnetFromIntegration({
        ...subnetInput,
        externalId,
        existingTargetId: ids.subnet,
        name: 'Renamed LAN',
        cidr: '10.1.0.50/24',
        gateway: '10.1.0.1',
      }),
    ).resolves.toMatchObject({ targetId: ids.subnet, change: 'updated' });
    expect(tx.subnet.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: ids.subnet,
          companyId: ids.company,
          name: 'LAN',
          cidr: '10.0.0.0/24',
        }),
        data: expect.objectContaining({ name: 'Renamed LAN', cidr: '10.1.0.0/24' }),
      }),
    );
  });

  it('blocks wrong-company and native CIDR collisions', async () => {
    const wrong = setup({ subnet: subnetRow({ companyId: 'other-company' }) }).service;
    await expect(wrong.writeSubnetFromIntegration({
      ...subnetInput,
      existingTargetId: ids.subnet,
    })).resolves.toMatchObject({ companyId: 'other-company', change: 'blocked' });
    const collision = setup({ subnetCollision: subnetRow() }).service;
    await expect(collision.writeSubnetFromIntegration(subnetInput)).resolves.toMatchObject({
      change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } },
    });
  });

  it('converges a second UUID-backed subnet source only through an eligible target binding', async () => {
    const firstExternalId = 'org:subnets:11111111-1111-4111-8111-111111111111';
    const secondExternalId = 'org:subnets:22222222-2222-4222-8222-222222222222';
    const targetBinding = binding('subnet', {
      externalId: firstExternalId,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'subnets',
        externalId: firstExternalId,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const { service, tx } = setup({
      subnetCollision: subnetRow(),
      targetBinding,
    });

    await expect(
      service.writeSubnetFromIntegration({
        ...subnetInput,
        externalId: secondExternalId,
        gateway: null,
        tx: tx as never,
      }),
    ).resolves.toEqual({ targetId: ids.subnet, companyId: ids.company, change: 'unchanged' });
    expect(tx.integrationSyncRecord.findFirst).toHaveBeenCalled();
    expect(tx.subnet.findFirst).toHaveBeenCalled();
  });

  it('does not adopt a canonical subnet collision when the exact bound target is missing', async () => {
    const firstExternalId = 'org:subnets:11111111-1111-4111-8111-111111111111';
    const targetBinding = binding('subnet', {
      externalId: firstExternalId,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'subnets',
        externalId: firstExternalId,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const { service } = setup({ subnetCollision: subnetRow(), targetBinding });

    await expect(
      service.writeSubnetFromIntegration({
        ...subnetInput,
        existingTargetId: ids.other,
      }),
    ).resolves.toMatchObject({
      change: 'blocked',
      gap: { kind: 'missing_dependency', details: { reasonCode: 'target_not_found' } },
    });
  });

  it.each([
    ['name', { name: 'Other LAN' }, ['name']],
    ['VLAN', { vlanId: 20 }, ['vlanId']],
    ['gateway', { gateway: '10.0.0.2' }, ['gateway']],
    ['DHCP range', { dhcpRangeStart: '10.0.0.100', dhcpRangeEnd: '10.0.0.200' }, ['dhcpRangeStart', 'dhcpRangeEnd']],
    ['description', { description: 'Other description' }, ['description']],
  ])('blocks canonical subnet convergence when %s conflicts', async (_field, override, fieldPaths) => {
    const firstExternalId = 'org:subnets:11111111-1111-4111-8111-111111111111';
    const { service, tx } = setup({
      subnetCollision: subnetRow({
        vlanId: 10,
        gateway: '10.0.0.1',
        dhcpRangeStart: '10.0.0.50',
        dhcpRangeEnd: '10.0.0.99',
        description: 'Canonical description',
      }),
      targetBinding: binding('subnet', {
        externalId: firstExternalId,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'subnets',
          externalId: firstExternalId,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(
      service.writeSubnetFromIntegration({
        ...subnetInput,
        externalId: 'org:subnets:22222222-2222-4222-8222-222222222222',
        vlanId: 10,
        dhcpRangeStart: '10.0.0.50',
        dhcpRangeEnd: '10.0.0.99',
        description: 'Canonical description',
        ...override,
        tx: tx as never,
      }),
    ).resolves.toMatchObject({
      change: 'blocked',
      gap: {
        kind: 'validation',
        details: { reasonCode: 'canonical_field_conflict', fieldPaths },
      },
    });
    expect(tx.subnet.updateMany).not.toHaveBeenCalled();
  });

  it('preserves first non-null canonical subnet values when a sibling omits them', async () => {
    const firstExternalId = 'org:subnets:11111111-1111-4111-8111-111111111111';
    const canonical = subnetRow({
      vlanId: 10,
      gateway: '10.0.0.1',
      dhcpRangeStart: '10.0.0.50',
      dhcpRangeEnd: '10.0.0.99',
      description: 'Canonical description',
    });
    const { service, tx } = setup({
      subnetCollision: canonical,
      targetBinding: binding('subnet', {
        externalId: firstExternalId,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'subnets',
          externalId: firstExternalId,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(service.writeSubnetFromIntegration({
      ...subnetInput,
      externalId: 'org:subnets:22222222-2222-4222-8222-222222222222',
      vlanId: null,
      gateway: null,
      dhcpRangeStart: null,
      dhcpRangeEnd: null,
      description: null,
      tx: tx as never,
    })).resolves.toEqual({
      targetId: ids.subnet,
      companyId: ids.company,
      change: 'unchanged',
    });
    expect(tx.subnet.updateMany).not.toHaveBeenCalled();
  });

  it('blocks a later page from changing a subnet field after canonical sharing', async () => {
    const siblingExternalId = 'org:subnets:22222222-2222-4222-8222-222222222222';
    const { service, tx } = setup({
      subnet: subnetRow(),
      binding: binding('subnet'),
      targetBinding: binding('subnet', {
        externalId: siblingExternalId,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'subnets',
          externalId: siblingExternalId,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(service.writeSubnetFromIntegration({
      ...subnetInput,
      existingTargetId: ids.subnet,
      name: 'Oscillating LAN',
      tx: tx as never,
    })).resolves.toMatchObject({
      change: 'blocked',
      gap: {
        details: {
          reasonCode: 'canonical_field_conflict',
          fieldPaths: ['name'],
        },
      },
    });
    expect(tx.subnet.updateMany).not.toHaveBeenCalled();
  });

  it('rebinds an exact UUID subnet source from A to an eligible canonical target B in the page transaction', async () => {
    const sourceA = 'org:subnets:11111111-1111-4111-8111-111111111111';
    const sourceB = 'org:subnets:22222222-2222-4222-8222-222222222222';
    const exactBinding = binding('subnet', {
      externalId: sourceA,
      subnetId: ids.subnet,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'subnets',
        externalId: sourceA,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const targetBinding = binding('subnet', {
      externalId: sourceB,
      subnetId: ids.other,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'subnets',
        externalId: sourceB,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const canonical = subnetRow({
      id: ids.other,
      cidr: '10.1.0.0/24',
      gateway: '10.1.0.1',
    });
    const { service, tx } = setup({
      subnet: subnetRow(),
      subnetCollision: canonical,
      binding: exactBinding,
      targetBinding,
    });

    await expect(
      service.writeSubnetFromIntegration({
        ...subnetInput,
        externalId: sourceA,
        existingTargetId: ids.subnet,
        cidr: '10.1.0.42/24',
        gateway: '10.1.0.1',
        tx: tx as never,
      }),
    ).resolves.toEqual({ targetId: ids.other, companyId: ids.company, change: 'unchanged' });
    expect(tx.subnet.findFirst).toHaveBeenCalledWith({
      where: {
        companyId: ids.company,
        cidr: '10.1.0.0/24',
        archivedAt: null,
        id: { not: ids.subnet },
      },
    });
    expect(tx.subnet.updateMany).not.toHaveBeenCalled();
  });

  it('blocks an exact UUID subnet source from rebinding onto a manual canonical target B', async () => {
    const sourceA = 'org:subnets:11111111-1111-4111-8111-111111111111';
    const exactBinding = binding('subnet', {
      externalId: sourceA,
      subnetId: ids.subnet,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'subnets',
        externalId: sourceA,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const { service, tx } = setup({
      subnet: subnetRow(),
      subnetCollision: subnetRow({
        id: ids.other,
        cidr: '10.1.0.0/24',
      }),
      binding: exactBinding,
    });

    await expect(
      service.writeSubnetFromIntegration({
        ...subnetInput,
        externalId: sourceA,
        existingTargetId: ids.subnet,
        cidr: '10.1.0.42/24',
        gateway: '10.1.0.1',
        tx: tx as never,
      }),
    ).resolves.toMatchObject({
      targetId: ids.other,
      change: 'blocked',
      gap: { details: { reasonCode: 'manual_ownership' } },
    });
    expect(tx.subnet.updateMany).not.toHaveBeenCalled();
  });

  it('blocks an exact UUID subnet source from rebinding onto a cross-company target B', async () => {
    const sourceA = 'org:subnets:11111111-1111-4111-8111-111111111111';
    const { service, tx } = setup({
      subnet: subnetRow(),
      subnetCollision: subnetRow({
        id: ids.other,
        companyId: 'other-company',
        cidr: '10.1.0.0/24',
      }),
      binding: binding('subnet', {
        externalId: sourceA,
        subnetId: ids.subnet,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'subnets',
          externalId: sourceA,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(
      service.writeSubnetFromIntegration({
        ...subnetInput,
        externalId: sourceA,
        existingTargetId: ids.subnet,
        cidr: '10.1.0.42/24',
        gateway: '10.1.0.1',
        tx: tx as never,
      }),
    ).resolves.toMatchObject({
      targetId: ids.other,
      companyId: 'other-company',
      change: 'blocked',
    });
    expect(tx.subnet.updateMany).not.toHaveBeenCalled();
  });

  it.each(['updated', 'unchanged'] as const)('classifies a verified reservation as %s', async (change) => {
    const current = reservationRow({ label: change === 'updated' ? 'Old Printer' : 'Printer' });
    const state = change === 'updated' ? 'stale' : 'active';
    const { service } = setup({
      subnet: subnetRow(),
      reservation: current,
      binding: binding('ip_reservation', { state, provenance: { integrationId: ids.integration, externalOrgId: 'org', resourceKey: 'reservations', externalId: 'org:reservations:printer', ownership: 'breeze', state } }),
    });
    await expect(service.writeReservationFromIntegration({
      companyId: ids.company,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping, resourceId: ids.resource, externalId: 'org:reservations:printer',
      auditActorId: ids.actor,
      dryRun: false,
      existingTargetId: ids.reservation,
      subnetId: ids.subnet,
      ipAddress: '10.0.0.50',
      label: 'Printer',
    })).resolves.toEqual({ targetId: ids.reservation, companyId: ids.company, change });
  });

  it('updates a reservation address through one stable UUID-backed source binding', async () => {
    const externalId = 'org:reservations:11111111-1111-4111-8111-111111111111';
    const { service, tx } = setup({
      subnet: subnetRow(),
      reservation: reservationRow(),
      binding: binding('ip_reservation', {
        externalId,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'reservations',
          externalId,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(
      service.writeReservationFromIntegration({
        companyId: ids.company,
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        externalId,
        auditActorId: ids.actor,
        dryRun: false,
        existingTargetId: ids.reservation,
        subnetId: ids.subnet,
        ipAddress: '10.0.0.51',
        label: 'Printer',
      }),
    ).resolves.toMatchObject({ targetId: ids.reservation, change: 'updated' });
    expect(tx.ipReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: ids.reservation,
          companyId: ids.company,
          ipAddress: '10.0.0.50',
        }),
        data: expect.objectContaining({ ipAddress: '10.0.0.51' }),
      }),
    );
  });

  it('keeps reservation dry-run side-effect free and blocks an IP collision', async () => {
    const dry = setup({ subnet: subnetRow() });
    await expect(dry.service.writeReservationFromIntegration({
      companyId: ids.company, integrationId: ids.integration, auditActorId: ids.actor,
      dryRun: true, integrationCompanyMappingId: ids.mapping, resourceId: ids.resource, externalId: 'org:reservations:printer', subnetId: ids.subnet, ipAddress: '10.0.0.50', label: 'Printer',
    })).resolves.toMatchObject({ change: 'created' });
    expect(dry.prisma.$transaction).not.toHaveBeenCalled();
    const collision = setup({ subnet: subnetRow(), reservationCollision: reservationRow() });
    await expect(collision.service.writeReservationFromIntegration({
      companyId: ids.company, integrationId: ids.integration, auditActorId: ids.actor,
      dryRun: false, integrationCompanyMappingId: ids.mapping, resourceId: ids.resource, externalId: 'org:reservations:printer', subnetId: ids.subnet, ipAddress: '10.0.0.50', label: 'Printer',
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
  });

  it('converges a second UUID-backed reservation source only through an eligible target binding', async () => {
    const firstExternalId = 'org:reservations:11111111-1111-4111-8111-111111111111';
    const secondExternalId = 'org:reservations:22222222-2222-4222-8222-222222222222';
    const targetBinding = binding('ip_reservation', {
      externalId: firstExternalId,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'reservations',
        externalId: firstExternalId,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const { service, tx } = setup({
      subnet: subnetRow(),
      reservationCollision: reservationRow(),
      targetBinding,
    });

    await expect(
      service.writeReservationFromIntegration({
        companyId: ids.company,
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        externalId: secondExternalId,
        tx: tx as never,
        auditActorId: ids.actor,
        dryRun: false,
        subnetId: ids.subnet,
        ipAddress: '10.0.0.50',
        label: 'Printer',
      }),
    ).resolves.toEqual({
      targetId: ids.reservation,
      companyId: ids.company,
      change: 'unchanged',
    });
    expect(tx.integrationSyncRecord.findFirst).toHaveBeenCalled();
    expect(tx.ipReservation.findFirst).toHaveBeenCalled();
  });

  it.each([
    ['label', { label: 'Other Printer' }, ['label']],
    ['notes', { notes: 'Other notes' }, ['notes']],
  ])('blocks canonical reservation convergence when %s conflicts', async (_field, override, fieldPaths) => {
    const firstExternalId = 'org:reservations:11111111-1111-4111-8111-111111111111';
    const { service, tx } = setup({
      subnet: subnetRow(),
      reservationCollision: reservationRow({ notes: 'Canonical notes' }),
      targetBinding: binding('ip_reservation', {
        externalId: firstExternalId,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'reservations',
          externalId: firstExternalId,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(service.writeReservationFromIntegration({
      companyId: ids.company,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      externalId: 'org:reservations:22222222-2222-4222-8222-222222222222',
      auditActorId: ids.actor,
      dryRun: false,
      subnetId: ids.subnet,
      ipAddress: '10.0.0.50',
      label: 'Printer',
      notes: 'Canonical notes',
      ...override,
      tx: tx as never,
    })).resolves.toMatchObject({
      change: 'blocked',
      gap: {
        details: { reasonCode: 'canonical_field_conflict', fieldPaths },
      },
    });
    expect(tx.ipReservation.updateMany).not.toHaveBeenCalled();
  });

  it('blocks instead of overwriting when the canonical reservation changes mid-write', async () => {
    const { service, audit, tx } = setup({
      subnet: subnetRow(),
      reservation: reservationRow(),
      binding: binding('ip_reservation'),
    });
    tx.ipReservation.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.writeReservationFromIntegration({
      companyId: ids.company,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      externalId: 'org:reservations:printer',
      auditActorId: ids.actor,
      dryRun: false,
      existingTargetId: ids.reservation,
      subnetId: ids.subnet,
      ipAddress: '10.0.0.50',
      label: 'Renamed Printer',
      tx: tx as never,
    })).resolves.toMatchObject({
      targetId: ids.reservation,
      change: 'blocked',
      gap: {
        kind: 'synchronization_error',
        details: { reasonCode: 'canonical_write_race' },
      },
    });
    expect(tx.ipReservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: ids.reservation,
          subnetId: ids.subnet,
          ipAddress: '10.0.0.50',
          label: 'Printer',
          notes: null,
        }),
      }),
    );
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('blocks a later page from changing a reservation after canonical sharing', async () => {
    const siblingExternalId = 'org:reservations:22222222-2222-4222-8222-222222222222';
    const { service, tx } = setup({
      subnet: subnetRow(),
      reservation: reservationRow(),
      binding: binding('ip_reservation'),
      targetBinding: binding('ip_reservation', {
        externalId: siblingExternalId,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'reservations',
          externalId: siblingExternalId,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(service.writeReservationFromIntegration({
      companyId: ids.company,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource,
      externalId: 'org:reservations:printer',
      auditActorId: ids.actor,
      dryRun: false,
      existingTargetId: ids.reservation,
      subnetId: ids.subnet,
      ipAddress: '10.0.0.50',
      label: 'Oscillating Printer',
      tx: tx as never,
    })).resolves.toMatchObject({
      change: 'blocked',
      gap: {
        details: {
          reasonCode: 'canonical_field_conflict',
          fieldPaths: ['label'],
        },
      },
    });
    expect(tx.ipReservation.updateMany).not.toHaveBeenCalled();
  });

  it('rebinds an exact UUID reservation source from A to an eligible canonical target B in the page transaction', async () => {
    const sourceA = 'org:reservations:11111111-1111-4111-8111-111111111111';
    const sourceB = 'org:reservations:22222222-2222-4222-8222-222222222222';
    const exactBinding = binding('ip_reservation', {
      externalId: sourceA,
      ipReservationId: ids.reservation,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'reservations',
        externalId: sourceA,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const targetBinding = binding('ip_reservation', {
      externalId: sourceB,
      ipReservationId: ids.other,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'reservations',
        externalId: sourceB,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const { service, tx } = setup({
      subnet: subnetRow(),
      reservation: reservationRow(),
      reservationCollision: reservationRow({ id: ids.other, ipAddress: '10.0.0.51' }),
      binding: exactBinding,
      targetBinding,
    });

    await expect(
      service.writeReservationFromIntegration({
        companyId: ids.company,
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        externalId: sourceA,
        auditActorId: ids.actor,
        dryRun: false,
        existingTargetId: ids.reservation,
        subnetId: ids.subnet,
        ipAddress: '10.0.0.51',
        label: 'Printer',
        tx: tx as never,
      }),
    ).resolves.toEqual({ targetId: ids.other, companyId: ids.company, change: 'unchanged' });
    expect(tx.ipReservation.findFirst).toHaveBeenCalledWith({
      where: {
        companyId: ids.company,
        subnetId: ids.subnet,
        ipAddress: '10.0.0.51',
        id: { not: ids.reservation },
      },
    });
    expect(tx.ipReservation.updateMany).not.toHaveBeenCalled();
  });

  it('blocks an exact UUID reservation source from rebinding onto a manual canonical target B', async () => {
    const sourceA = 'org:reservations:11111111-1111-4111-8111-111111111111';
    const exactBinding = binding('ip_reservation', {
      externalId: sourceA,
      ipReservationId: ids.reservation,
      provenance: {
        integrationId: ids.integration,
        externalOrgId: 'org',
        resourceKey: 'reservations',
        externalId: sourceA,
        ownership: 'breeze',
        state: 'active',
      },
    });
    const { service, tx } = setup({
      subnet: subnetRow(),
      reservation: reservationRow(),
      reservationCollision: reservationRow({ id: ids.other, ipAddress: '10.0.0.51' }),
      binding: exactBinding,
    });

    await expect(
      service.writeReservationFromIntegration({
        companyId: ids.company,
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        externalId: sourceA,
        auditActorId: ids.actor,
        dryRun: false,
        existingTargetId: ids.reservation,
        subnetId: ids.subnet,
        ipAddress: '10.0.0.51',
        label: 'Printer',
        tx: tx as never,
      }),
    ).resolves.toMatchObject({
      targetId: ids.other,
      change: 'blocked',
      gap: { details: { reasonCode: 'manual_ownership' } },
    });
    expect(tx.ipReservation.updateMany).not.toHaveBeenCalled();
  });

  it('blocks an exact UUID reservation source from rebinding onto a cross-company target B', async () => {
    const sourceA = 'org:reservations:11111111-1111-4111-8111-111111111111';
    const { service, tx } = setup({
      subnet: subnetRow(),
      reservation: reservationRow(),
      reservationCollision: reservationRow({
        id: ids.other,
        companyId: 'other-company',
        ipAddress: '10.0.0.51',
      }),
      binding: binding('ip_reservation', {
        externalId: sourceA,
        ipReservationId: ids.reservation,
        provenance: {
          integrationId: ids.integration,
          externalOrgId: 'org',
          resourceKey: 'reservations',
          externalId: sourceA,
          ownership: 'breeze',
          state: 'active',
        },
      }),
    });

    await expect(
      service.writeReservationFromIntegration({
        companyId: ids.company,
        integrationId: ids.integration,
        integrationCompanyMappingId: ids.mapping,
        resourceId: ids.resource,
        externalId: sourceA,
        auditActorId: ids.actor,
        dryRun: false,
        existingTargetId: ids.reservation,
        subnetId: ids.subnet,
        ipAddress: '10.0.0.51',
        label: 'Printer',
        tx: tx as never,
      }),
    ).resolves.toMatchObject({
      targetId: ids.other,
      companyId: 'other-company',
      change: 'blocked',
    });
    expect(tx.ipReservation.updateMany).not.toHaveBeenCalled();
  });

  it('rejects an arbitrary existing reservation and a wrong-company reservation', async () => {
    const manual = setup({ subnet: subnetRow(), reservation: reservationRow() });
    await expect(manual.service.writeReservationFromIntegration({
      companyId: ids.company, integrationId: ids.integration, auditActorId: ids.actor,
      dryRun: false, existingTargetId: ids.reservation, integrationCompanyMappingId: ids.mapping, resourceId: ids.resource, externalId: 'org:reservations:printer',
      subnetId: ids.subnet, ipAddress: '10.0.0.50', label: 'Printer',
    })).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(manual.tx.ipReservation.updateMany).not.toHaveBeenCalled();

    const wrong = setup({ subnet: subnetRow(), reservation: reservationRow({ companyId: 'other-company' }) });
    await expect(wrong.service.writeReservationFromIntegration({
      companyId: ids.company, integrationId: ids.integration, auditActorId: ids.actor,
      dryRun: false, existingTargetId: ids.reservation, integrationCompanyMappingId: ids.mapping, resourceId: ids.resource, externalId: 'org:reservations:printer',
      subnetId: ids.subnet, ipAddress: '10.0.0.50', label: 'Printer',
    })).resolves.toMatchObject({ companyId: 'other-company', change: 'blocked' });
  });

  it.each([
    ['missing', null], ['wrong mapping', binding('ip_reservation', { integrationCompanyMappingId: ids.other })],
    ['wrong resource', binding('ip_reservation', { resourceId: ids.other })], ['wrong external id', binding('ip_reservation', { externalId: 'wrong' })],
    ['wrong kind', binding('ip_reservation', { targetKind: 'article' })], ['wrong id', binding('ip_reservation', { ipReservationId: ids.other })],
    ['wrong company', binding('ip_reservation', { companyId: 'other-company' })],
    ['blocked', binding('ip_reservation', { state: 'blocked', provenance: { integrationId: ids.integration, ownership: 'breeze', state: 'blocked' } })],
    ['manual', binding('ip_reservation', { provenance: { integrationId: ids.integration, ownership: 'weavestream', state: 'active' } })],
  ])('rejects a %s reservation binding despite a forged legacy flag', async (_label, persistedBinding) => {
    const { service, tx } = setup({ subnet: subnetRow(), reservation: reservationRow({ label: 'Old' }), binding: persistedBinding });
    await expect(service.writeReservationFromIntegration({
      companyId: ids.company, integrationId: ids.integration, integrationCompanyMappingId: ids.mapping,
      resourceId: ids.resource, externalId: 'org:reservations:printer', auditActorId: ids.actor,
      dryRun: false, existingTargetId: ids.reservation, ownershipVerified: true,
      subnetId: ids.subnet, ipAddress: '10.0.0.50', label: 'Printer',
    } as never)).resolves.toMatchObject({ change: 'blocked', gap: { details: { reasonCode: 'manual_ownership' } } });
    expect(tx.ipReservation.updateMany).not.toHaveBeenCalled();
  });
});
