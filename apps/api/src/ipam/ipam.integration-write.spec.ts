import { IpamService } from './ipam.service.js';

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
    state: 'active', provenance: { integrationId: ids.integration, ownership: 'breeze', state: 'active' },
    ...overrides,
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

function setup(options: { subnet?: unknown; reservation?: unknown; subnetCollision?: unknown; reservationCollision?: unknown; binding?: unknown; auditFails?: boolean } = {}) {
  let committed = false;
  const createdSubnet = subnetRow();
  const createdReservation = reservationRow();
  const tx = {
    subnet: {
      create: jest.fn().mockResolvedValue(createdSubnet),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue(options.subnet ?? createdSubnet),
    },
    ipReservation: {
      create: jest.fn().mockResolvedValue(createdReservation),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirstOrThrow: jest.fn().mockResolvedValue(options.reservation ?? createdReservation),
    },
    integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(options.binding ?? null) },
    auditLog: { create: jest.fn() },
  };
  const prisma = {
    subnet: {
      findUnique: jest.fn().mockResolvedValue(options.subnet ?? null),
      findFirst: jest.fn().mockResolvedValue(options.subnetCollision ?? null),
      create: tx.subnet.create,
      updateMany: tx.subnet.updateMany,
      findFirstOrThrow: tx.subnet.findFirstOrThrow,
    },
    ipReservation: {
      findUnique: jest.fn().mockResolvedValue(options.reservation ?? null),
      findFirst: jest.fn().mockResolvedValue(options.reservationCollision ?? null),
      create: tx.ipReservation.create,
      updateMany: tx.ipReservation.updateMany,
      findFirstOrThrow: tx.ipReservation.findFirstOrThrow,
    },
    integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(options.binding ?? null) },
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
    const { service } = setup({ subnet, binding: binding('subnet', { state, provenance: { integrationId: ids.integration, ownership: 'breeze', state } }) });
    await expect(service.writeSubnetFromIntegration({
      ...subnetInput,
      existingTargetId: ids.subnet,
      name,
    })).resolves.toEqual({ targetId: ids.subnet, companyId: ids.company, change });
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

  it.each(['updated', 'unchanged'] as const)('classifies a verified reservation as %s', async (change) => {
    const current = reservationRow({ label: change === 'updated' ? 'Old Printer' : 'Printer' });
    const state = change === 'updated' ? 'stale' : 'active';
    const { service } = setup({
      subnet: subnetRow(),
      reservation: current,
      binding: binding('ip_reservation', { state, provenance: { integrationId: ids.integration, ownership: 'breeze', state } }),
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
