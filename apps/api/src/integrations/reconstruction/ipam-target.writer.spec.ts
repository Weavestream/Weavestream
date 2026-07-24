import {
  IpReservationTargetWriter,
  SubnetTargetWriter,
  type IpamIntegrationWritePort,
} from './ipam-target.writer.js';
import type {
  IpReservationReconstructionInput,
  ReconstructionWriteContext,
  SubnetReconstructionInput,
} from './reconstruction-target.js';

const ids = {
  company: '10000000-0000-0000-0000-000000000001',
  otherCompany: '10000000-0000-0000-0000-000000000002',
  integration: '10000000-0000-0000-0000-000000000003',
  mapping: '10000000-0000-0000-0000-000000000004',
  resource: '10000000-0000-0000-0000-000000000005',
  actor: '10000000-0000-0000-0000-000000000006',
  subnet: '10000000-0000-0000-0000-000000000007',
  reservation: '10000000-0000-0000-0000-000000000008',
};

const subnetInput: SubnetReconstructionInput = {
  targetKind: 'subnet',
  externalId: 'org-1:subnets:lan-1',
  source: { externalOrgId: 'org-1', resourceKey: 'subnets', sourceId: 'lan-1', fingerprint: 'sha256:lan' },
  name: 'LAN',
  cidr: '10.0.0.42/24',
  gateway: '10.0.0.1',
};

const reservationInput: IpReservationReconstructionInput = {
  targetKind: 'ip_reservation',
  externalId: 'org-1:reservations:printer',
  source: { externalOrgId: 'org-1', resourceKey: 'reservations', sourceId: 'printer' },
  subnetRef: { resourceKey: 'subnets', externalId: 'org-1:subnets:lan-1' },
  ipAddress: ' 10.0.0.50 ',
  label: 'Printer',
};

function context(resourceKey: string, overrides: Partial<ReconstructionWriteContext> = {}): ReconstructionWriteContext {
  const ctx: ReconstructionWriteContext = {
    tx: {} as never,
    companyId: ids.company,
    integrationId: ids.integration,
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    resourceKey,
    externalOrgId: 'org-1',
    auditActorId: ids.actor,
    now: new Date('2026-07-13T18:00:00.000Z'),
    dryRun: false,
    resolveBinding: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
  if (ctx.existingTargetId && overrides.previousProvenance === undefined) {
    const source = resourceKey === 'subnets' ? subnetInput : reservationInput;
    ctx.previousProvenance = {
      integrationId: ids.integration,
      externalOrgId: 'org-1',
      resourceKey,
      externalId: source.externalId,
      sourceRevision: source.source.revision ?? null,
      sourceFingerprint: source.source.fingerprint ?? null,
      firstSeenAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-01T00:00:00.000Z',
      lastSyncedAt: '2026-07-01T00:00:00.000Z',
      ownership: 'breeze',
      state: ctx.existingState === 'stale' ? 'stale' : 'active',
    };
  }
  return ctx;
}

function port(overrides: Partial<IpamIntegrationWritePort> = {}) {
  return {
    writeSubnetFromIntegration: jest.fn().mockResolvedValue({ targetId: ids.subnet, companyId: ids.company, change: 'created' }),
    writeReservationFromIntegration: jest.fn().mockResolvedValue({ targetId: ids.reservation, companyId: ids.company, change: 'created' }),
    ...overrides,
  };
}

describe('SubnetTargetWriter', () => {
  it('normalizes CIDR before native validation and create', async () => {
    const service = port();
    const writer = new SubnetTargetWriter(service);
    expect(writer.validate(subnetInput).cidr).toBe('10.0.0.0/24');
    const out = await writer.write(context('subnets'), subnetInput);
    expect(out.change).toBe('created');
    expect(service.writeSubnetFromIntegration).toHaveBeenCalledWith(expect.objectContaining({ cidr: '10.0.0.0/24', companyId: ids.company }));
  });

  it.each(['updated', 'unchanged'] as const)('returns %s from native writes', async (change) => {
    const writer = new SubnetTargetWriter(port({ writeSubnetFromIntegration: jest.fn().mockResolvedValue({ targetId: ids.subnet, companyId: ids.company, change }) }));
    await expect(writer.write(context('subnets', { existingTargetId: ids.subnet }), subnetInput)).resolves.toMatchObject({ change });
  });

  it('restores an archived/stale bound subnet', async () => {
    const service = port({ writeSubnetFromIntegration: jest.fn().mockResolvedValue({ targetId: ids.subnet, companyId: ids.company, change: 'restored' }) });
    const writer = new SubnetTargetWriter(service);
    await expect(writer.write(context('subnets', { existingTargetId: ids.subnet, existingState: 'stale' }), subnetInput)).resolves.toMatchObject({ change: 'restored' });
  });

  it('blocks wrong-company targets and service-reported manual collisions', async () => {
    const wrong = new SubnetTargetWriter(port({ writeSubnetFromIntegration: jest.fn().mockResolvedValue({ targetId: ids.subnet, companyId: ids.otherCompany, change: 'updated' }) }));
    await expect(wrong.write(context('subnets', { existingTargetId: ids.subnet }), subnetInput)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
    const collision = new SubnetTargetWriter(port({ writeSubnetFromIntegration: jest.fn().mockResolvedValue({ targetId: '', companyId: ids.company, change: 'blocked', gap: { kind: 'ambiguous', message: 'A manual subnet already owns this CIDR.', details: { reasonCode: 'manual_ownership' } } }) }));
    await expect(collision.write(context('subnets'), subnetInput)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'ambiguous' })] });
  });

  it('returns sanitized validation/missing-dependency gaps and blocks source collisions', async () => {
    const service = port();
    const writer = new SubnetTargetWriter(service);
    await expect(writer.write(context('subnets'), { ...subnetInput, cidr: 'not-a-cidr' })).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
    const missing = new SubnetTargetWriter(port({ writeSubnetFromIntegration: jest.fn().mockResolvedValue({ targetId: '', companyId: ids.company, change: 'blocked', gap: { kind: 'missing_dependency', message: 'Native dependency missing.', details: { reasonCode: 'dependency_not_found' } } }) }));
    await expect(missing.write(context('subnets'), subnetInput)).resolves.toMatchObject({ gaps: [expect.objectContaining({ kind: 'missing_dependency' })] });
    const previous = { integrationId: ids.integration, externalOrgId: 'other', resourceKey: 'subnets', externalId: subnetInput.externalId, sourceRevision: null, sourceFingerprint: null, firstSeenAt: '2026-07-01T00:00:00.000Z', lastSeenAt: '2026-07-01T00:00:00.000Z', lastSyncedAt: '2026-07-01T00:00:00.000Z', ownership: 'breeze' as const, state: 'active' as const };
    await expect(writer.write(context('subnets', { previousProvenance: previous }), subnetInput)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'ambiguous' })] });
  });

  it('returns bounded source provenance without native fields', async () => {
    const out = await new SubnetTargetWriter(port()).write(context('subnets'), subnetInput);
    expect(out.provenance.sourceFingerprint).toBe('sha256:lan');
    expect(JSON.stringify(out.provenance)).not.toContain('10.0.0.0');
    expect(Buffer.byteLength(JSON.stringify(out.provenance))).toBeLessThanOrEqual(8192);
  });

  it('rejects a secret-bearing subnet description before native validation/write', async () => {
    const service = port();
    const out = await new SubnetTargetWriter(service).write(
      context('subnets'),
      { ...subnetInput, description: 'Bearer abcdefghijklmnopqrstuvwxyz' },
    );
    expect(out).toMatchObject({ gaps: [{ details: { reasonCode: 'sensitive_input' } }] });
    expect(service.writeSubnetFromIntegration).not.toHaveBeenCalled();
  });
});

describe('IpReservationTargetWriter', () => {
  it('resolves the same-company subnet and creates with normalized IPv4', async () => {
    const service = port();
    const writer = new IpReservationTargetWriter(service);
    const ctx = context('reservations', { resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'subnet', targetId: ids.subnet, companyId: ids.company }) });
    const out = await writer.write(ctx, reservationInput);
    expect(out.change).toBe('created');
    expect(service.writeReservationFromIntegration).toHaveBeenCalledWith(expect.objectContaining({ subnetId: ids.subnet, ipAddress: '10.0.0.50' }));
  });

  it('canonicalizes leading-zero IPv4 octets before native lookup/write', async () => {
    const service = port();
    const writer = new IpReservationTargetWriter(service);
    const ctx = context('reservations', { resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'subnet', targetId: ids.subnet, companyId: ids.company }) });
    await writer.write(ctx, { ...reservationInput, ipAddress: '010.000.000.050' });
    expect(service.writeReservationFromIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '10.0.0.50' }),
    );
  });

  it.each(['updated', 'unchanged'] as const)('returns %s from native writes', async (change) => {
    const service = port({ writeReservationFromIntegration: jest.fn().mockResolvedValue({ targetId: ids.reservation, companyId: ids.company, change }) });
    const ctx = context('reservations', { existingTargetId: ids.reservation, resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'subnet', targetId: ids.subnet, companyId: ids.company }) });
    await expect(new IpReservationTargetWriter(service).write(ctx, reservationInput)).resolves.toMatchObject({ change });
  });

  it('marks a stale bound reservation restored after a successful idempotent write', async () => {
    const service = port({ writeReservationFromIntegration: jest.fn().mockResolvedValue({ targetId: ids.reservation, companyId: ids.company, change: 'unchanged' }) });
    const ctx = context('reservations', { existingTargetId: ids.reservation, existingState: 'stale', resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'subnet', targetId: ids.subnet, companyId: ids.company }) });
    await expect(new IpReservationTargetWriter(service).write(ctx, reservationInput)).resolves.toMatchObject({ change: 'restored' });
  });

  it('blocks missing/wrong-company dependencies and wrong-company existing targets', async () => {
    const service = port();
    const writer = new IpReservationTargetWriter(service);
    await expect(writer.write(context('reservations'), reservationInput)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'missing_dependency' })] });
    const cross = context('reservations', { resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'subnet', targetId: ids.subnet, companyId: ids.otherCompany }) });
    await expect(writer.write(cross, reservationInput)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
    const wrongTarget = port({ writeReservationFromIntegration: jest.fn().mockResolvedValue({ targetId: ids.reservation, companyId: ids.otherCompany, change: 'updated' }) });
    const bound = context('reservations', { existingTargetId: ids.reservation, resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'subnet', targetId: ids.subnet, companyId: ids.company }) });
    await expect(new IpReservationTargetWriter(wrongTarget).write(bound, reservationInput)).resolves.toMatchObject({ change: 'blocked' });
  });

  it('blocks invalid input, manual ownership, and source identity collisions', async () => {
    const dependency = { targetKind: 'subnet' as const, targetId: ids.subnet, companyId: ids.company };
    const ctx = context('reservations', { resolveBinding: jest.fn().mockResolvedValue(dependency) });
    await expect(new IpReservationTargetWriter(port()).write(ctx, { ...reservationInput, ipAddress: '999.1.1.1' })).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'validation' })] });
    const manual = port({ writeReservationFromIntegration: jest.fn().mockResolvedValue({ targetId: '', companyId: ids.company, change: 'blocked', gap: { kind: 'ambiguous', message: 'A manual reservation owns this IP.', details: { reasonCode: 'manual_ownership' } } }) });
    await expect(new IpReservationTargetWriter(manual).write(ctx, reservationInput)).resolves.toMatchObject({ gaps: [expect.objectContaining({ kind: 'ambiguous' })] });
    const previous = { integrationId: ids.integration, externalOrgId: 'org-1', resourceKey: 'other', externalId: reservationInput.externalId, sourceRevision: null, sourceFingerprint: null, firstSeenAt: '2026-07-01T00:00:00.000Z', lastSeenAt: '2026-07-01T00:00:00.000Z', lastSyncedAt: '2026-07-01T00:00:00.000Z', ownership: 'breeze' as const, state: 'active' as const };
    await expect(new IpReservationTargetWriter(port()).write(context('reservations', { previousProvenance: previous, resolveBinding: jest.fn().mockResolvedValue(dependency) }), reservationInput)).resolves.toMatchObject({ change: 'blocked', gaps: [expect.objectContaining({ kind: 'ambiguous' })] });
  });

  it('returns bounded provenance without reservation notes', async () => {
    const ctx = context('reservations', { resolveBinding: jest.fn().mockResolvedValue({ targetKind: 'subnet', targetId: ids.subnet, companyId: ids.company }) });
    const out = await new IpReservationTargetWriter(port()).write(ctx, { ...reservationInput, notes: 'manual printer password is elsewhere' });
    expect(out.provenance.externalId).toBe(reservationInput.externalId);
    expect(JSON.stringify(out.provenance)).not.toContain('printer password');
    expect(Buffer.byteLength(JSON.stringify(out.provenance))).toBeLessThanOrEqual(8192);
  });

  it('rejects secret-bearing reservation notes before resolving dependencies or writing', async () => {
    const service = port();
    const resolveBinding = jest.fn();
    const out = await new IpReservationTargetWriter(service).write(
      context('reservations', { resolveBinding }),
      { ...reservationInput, notes: 'AKIAIOSFODNN7EXAMPLE' },
    );
    expect(out).toMatchObject({ gaps: [{ details: { reasonCode: 'sensitive_input' } }] });
    expect(resolveBinding).not.toHaveBeenCalled();
    expect(service.writeReservationFromIntegration).not.toHaveBeenCalled();
  });
});
