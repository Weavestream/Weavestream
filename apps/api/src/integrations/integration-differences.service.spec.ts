import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { resolveIntegrationDifferencesBulkSchema } from '@weavestream/shared';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import {
  AssetIntegrationDifferencesController,
  IntegrationDifferencesController,
} from './integration-differences.controller.js';

jest.mock('../uploads/uploads.service.js', () => ({ UploadsService: class UploadsService {} }));

let IntegrationDifferencesService: typeof import('./integration-differences.service.js').IntegrationDifferencesService;
beforeAll(async () => {
  ({ IntegrationDifferencesService } = await import('./integration-differences.service.js'));
});

const ADMIN = { id: 'user-1', role: 'SUPER_ADMIN' } as never;
const META = { ip: '203.0.113.1', userAgent: 'jest' };
const COMPANY = '00000000-0000-4000-8000-0000000000c1';
const ASSET = '00000000-0000-4000-8000-0000000000a1';
const RECORD = '00000000-0000-4000-8000-0000000000e1';
const FIELD = '00000000-0000-4000-8000-0000000000f1';
const UPDATED_AT = new Date('2026-10-01T00:00:00.000Z');
const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: RECORD,
    updatedAt: UPDATED_AT,
    fieldDiffs: {
      [FIELD]: { sourceValue: 'host-b', sourceFingerprint: checksum('host-b'), localFingerprint: checksum('mine'), detectedAt: '2026-10-01T00:00:00.000Z' },
    },
    fieldResolutions: {},
    lastSyncedFieldChecksums: { [FIELD]: checksum('host-a') },
    integrationCompanyMappingId: 'map-1',
    resourceId: 'res-1',
    companyMapping: { integrationId: 'int-1' },
    ...overrides,
  };
}

function setup(found: unknown = record()) {
  const prisma = {
    integrationSyncRecord: {
      findFirst: jest.fn().mockResolvedValue(found),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn(),
    },
    assetField: { findFirst: jest.fn().mockResolvedValue({ slug: 'hostname' }), findMany: jest.fn() },
    assetFieldValue: { findFirst: jest.fn().mockResolvedValue({ value: 'host-b' }), findMany: jest.fn() },
    integration: { findUnique: jest.fn() },
    $transaction: jest.fn(),
  };
  let commits = 0;
  prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
    const result = await callback(prisma);
    commits += 1;
    return result;
  });
  const audit = { log: jest.fn().mockResolvedValue(undefined), logWithClient: jest.fn().mockResolvedValue(undefined) };
  const assets = { update: jest.fn().mockResolvedValue({}) };
  const provenance = { lockScope: jest.fn().mockResolvedValue(undefined) };
  const permissions = { can: jest.fn().mockResolvedValue({ allowed: true }) };
  const service = new IntegrationDifferencesService(prisma as never, audit as never, assets as never, provenance as never, permissions as never);
  return { service, prisma, audit, assets, provenance, permissions, commits: () => commits };
}

const input = (choice: 'source' | 'local') => ({ syncRecordId: RECORD, assetFieldId: FIELD, choice });

describe('IntegrationDifferencesService.resolve', () => {
  it('Use source writes through the operator path, follows the source again and clears the difference', async () => {
    const { service, prisma, audit, assets, provenance } = setup();
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).resolves.toEqual({ ok: true });
    // Serialized with sync pages through the runner's scope lock, in one transaction.
    expect(provenance.lockScope).toHaveBeenCalledWith(prisma, expect.objectContaining({
      companyId: COMPANY, integrationCompanyMappingId: 'map-1', resourceId: 'res-1',
    }));
    expect(provenance.lockScope.mock.invocationCallOrder[0]).toBeLessThan(prisma.integrationSyncRecord.updateMany.mock.invocationCallOrder[0]!);
    expect(prisma.integrationSyncRecord.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: RECORD, companyId: COMPANY, assetId: ASSET, targetKind: 'asset' },
    }));
    expect(assets.update).toHaveBeenCalledWith(ADMIN, COMPANY, ASSET, { fieldValues: { hostname: 'host-b' } }, META, prisma);
    // The binding is claimed before the asset write.
    expect(prisma.integrationSyncRecord.updateMany.mock.invocationCallOrder[0]).toBeLessThan(assets.update.mock.invocationCallOrder[0]!);
    expect(prisma.integrationSyncRecord.updateMany).toHaveBeenCalledWith({
      where: { id: RECORD, companyId: COMPANY, updatedAt: UPDATED_AT },
      data: { fieldDiffs: {}, fieldResolutions: {}, lastSyncedFieldChecksums: { [FIELD]: checksum('host-b') } },
    });
    // Written with the transaction client, after the asset write.
    expect(audit.log).not.toHaveBeenCalled();
    expect(audit.logWithClient).toHaveBeenCalledTimes(1);
    expect(assets.update.mock.invocationCallOrder[0]).toBeLessThan(audit.logWithClient.mock.invocationCallOrder[0]!);
    expect(audit.logWithClient).toHaveBeenCalledWith(prisma, expect.objectContaining({
      action: 'integration.difference.resolve',
      companyId: COMPANY,
      entityId: ASSET,
      after: { integrationId: 'int-1', syncRecordId: RECORD, assetFieldId: FIELD, choice: 'source' },
    }));
  });

  it('Keep ours stores the choice against the source value and writes nothing to the asset', async () => {
    const { service, prisma, assets } = setup();
    await service.resolve(ADMIN, COMPANY, ASSET, input('local'), META);
    expect(assets.update).not.toHaveBeenCalled();
    expect(prisma.integrationSyncRecord.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fieldDiffs: {},
        fieldResolutions: { [FIELD]: { choice: 'local', sourceFingerprint: checksum('host-b') } },
        lastSyncedFieldChecksums: { [FIELD]: checksum('host-a') },
      }),
    }));
  });

  it('404s a record outside that asset and company, or a difference that is no longer open', async () => {
    const missing = setup(null);
    await expect(missing.service.resolve(ADMIN, COMPANY, ASSET, input('local'), META)).rejects.toBeInstanceOf(NotFoundException);
    const closed = setup(record({ fieldDiffs: {} }));
    await expect(closed.service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).rejects.toBeInstanceOf(NotFoundException);
    expect(closed.assets.update).not.toHaveBeenCalled();
  });

  it('denies client users before reading anything', async () => {
    const { service, prisma } = setup();
    await expect(service.resolve({ id: 'u', role: 'CLIENT_USER' } as never, COMPANY, ASSET, input('local'), META))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.integrationSyncRecord.findFirst).not.toHaveBeenCalled();
  });

  it('reports a sync that rewrote the record in between as a conflict (Keep ours)', async () => {
    const { service, prisma, audit } = setup();
    prisma.integrationSyncRecord.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('local'), META)).rejects.toBeInstanceOf(ConflictException);
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('rolls back with the asset write when it fails, and logs no resolution', async () => {
    const { service, assets, audit } = setup();
    assets.update.mockRejectedValue(new Error('invalid value'));
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).rejects.toThrow('invalid value');
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('rolls the resolution back when its audit row cannot be written', async () => {
    const { service, prisma, audit, assets, commits } = setup();
    audit.logWithClient.mockRejectedValue(new Error('audit down'));
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).rejects.toThrow('audit down');
    // The failure happens inside the transaction, so the record and asset writes never commit.
    expect(prisma.integrationSyncRecord.updateMany).toHaveBeenCalled();
    expect(assets.update).toHaveBeenCalled();
    expect(commits()).toBe(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('writes nothing to the asset when a sync touched the record first (Use source)', async () => {
    const { service, prisma, audit, assets } = setup();
    prisma.integrationSyncRecord.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.resolve(ADMIN, COMPANY, ASSET, input('source'), META)).rejects.toBeInstanceOf(ConflictException);
    expect(assets.update).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });

  it('requires asset.write on the path company (no asset.write -> 403 from the guard)', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, AssetIntegrationDifferencesController.prototype.resolve)).toEqual({
      action: 'asset.write',
      companyIdFrom: 'params.companyId',
    });
  });
});

describe('IntegrationDifferencesService.list', () => {
  const OTHER = '00000000-0000-4000-8000-0000000000c2';
  const row = (id: string) => ({
    id, companyId: COMPANY, assetId: ASSET,
    fieldDiffs: { [FIELD]: { sourceValue: 'host-b', sourceFingerprint: 's', localFingerprint: 'l', detectedAt: '2026-10-01T00:00:00.000Z' } },
    asset: { name: 'Workstation 01', company: { name: 'Example Co' } },
  });

  function listSetup(rows: ReturnType<typeof row>[]) {
    const ctx = setup();
    ctx.prisma.integration.findUnique.mockResolvedValue({ companyMappings: [{ companyId: COMPANY }] });
    ctx.prisma.integrationSyncRecord.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(rows.map((r) => ({ fieldDiffs: r.fieldDiffs })));
    ctx.prisma.assetField.findMany.mockResolvedValue([{ id: FIELD, name: 'Hostname' }]);
    ctx.prisma.assetFieldValue.findMany.mockResolvedValue([{ assetId: ASSET, assetFieldId: FIELD, value: 'mine' }]);
    return ctx;
  }

  it('returns company, asset, field, both values and a cursor when more rows follow', async () => {
    const { service, prisma } = listSetup([row('00000000-0000-4000-8000-000000000001'), row('00000000-0000-4000-8000-000000000002')]);
    const page = await service.list('int-1', { limit: 1 });
    expect(page.items).toEqual([{
      syncRecordId: '00000000-0000-4000-8000-000000000001', companyId: COMPANY, companyName: 'Example Co',
      assetId: ASSET, assetName: 'Workstation 01', assetFieldId: FIELD, fieldLabel: 'Hostname',
      localValue: 'mine', sourceValue: 'host-b', detectedAt: '2026-10-01T00:00:00.000Z',
    }]);
    expect(page.nextCursor).toBe('00000000-0000-4000-8000-000000000001');
    expect(page.total).toBe(2);
    const where = prisma.integrationSyncRecord.findMany.mock.calls[0]![0].where;
    expect(where).toMatchObject({ companyId: { in: [COMPANY] }, companyMapping: { integrationId: 'int-1' } });
  });

  it('continues after the cursor without recounting', async () => {
    const { service, prisma } = listSetup([row('00000000-0000-4000-8000-000000000002')]);
    const page = await service.list('int-1', { limit: 1, cursor: '00000000-0000-4000-8000-000000000001' });
    expect(page.nextCursor).toBeNull();
    expect(page.total).toBeNull();
    expect(prisma.integrationSyncRecord.findMany.mock.calls[0]![0].where.id).toEqual({ gt: '00000000-0000-4000-8000-000000000001' });
  });

  it('404s a company filter that is not mapped to the integration, and an unknown integration', async () => {
    const { service, prisma } = listSetup([]);
    await expect(service.list('int-1', { limit: 50, companyId: OTHER })).rejects.toBeInstanceOf(NotFoundException);
    prisma.integration.findUnique.mockResolvedValue(null);
    await expect(service.list('nope', { limit: 50 })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is gated by integration.manage', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, IntegrationDifferencesController.prototype.list)).toEqual({
      action: 'integration.manage',
      companyIdFrom: undefined,
    });
  });
});

describe('IntegrationDifferencesService.resolveBulk', () => {
  const OTHER = '00000000-0000-4000-8000-0000000000c2';
  const ASSET_2 = '00000000-0000-4000-8000-0000000000a2';
  const FIELD_2 = '00000000-0000-4000-8000-0000000000f2';
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const diff = { sourceValue: 'host-b', sourceFingerprint: checksum('host-b'), localFingerprint: checksum('mine'), detectedAt: '2026-10-01T00:00:00.000Z' };
  const row = (recordId: string, companyId = COMPANY, fields = [FIELD]) => ({
    id: recordId, companyId, assetId: companyId === COMPANY ? ASSET : ASSET_2,
    fieldDiffs: Object.fromEntries(fields.map((f) => [f, diff])),
    asset: { name: `Asset ${recordId.slice(-2)}` },
  });

  /** `rows` answer the selection; `resolve` then re-reads each record by id. */
  function bulkSetup(rows: Array<ReturnType<typeof row>>, mapped = [COMPANY, OTHER]) {
    const ctx = setup();
    ctx.prisma.integration.findUnique.mockResolvedValue({ companyMappings: mapped.map((companyId) => ({ companyId })) });
    ctx.prisma.integrationSyncRecord.findMany.mockResolvedValue(rows);
    ctx.prisma.integrationSyncRecord.findFirst.mockImplementation(async ({ where }: { where: { id: string } }) => {
      const found = rows.find((r) => r.id === where.id);
      return found ? record({ id: found.id, fieldDiffs: found.fieldDiffs }) : null;
    });
    return ctx;
  }

  it('resolves ticked rows, checks asset.write once per company and skips the ones the actor cannot edit', async () => {
    const rows = [row(id(1), COMPANY, [FIELD, FIELD_2]), row(id(2), OTHER)];
    const { service, prisma, permissions, audit, assets } = bulkSetup(rows);
    permissions.can.mockImplementation(async (_user: unknown, _action: string, target: { companyId: string }) => ({ allowed: target.companyId === COMPANY }));
    const result = await service.resolveBulk(ADMIN, 'int-1', {
      choice: 'local',
      items: [
        { syncRecordId: id(1), assetFieldId: FIELD },
        { syncRecordId: id(1), assetFieldId: FIELD_2 },
        { syncRecordId: id(1), assetFieldId: FIELD }, // duplicate: once
        { syncRecordId: id(2), assetFieldId: FIELD },
        { syncRecordId: id(9), assetFieldId: FIELD }, // another integration's record: not returned
      ],
    }, META);
    expect(result.applied).toBe(2);
    expect(result.failed).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(result.skipped).toEqual([
      { syncRecordId: id(9), assetFieldId: FIELD, assetName: null, reason: 'This difference is no longer open.' },
      { syncRecordId: id(2), assetFieldId: FIELD, assetName: 'Asset 02', reason: 'You cannot edit assets in this company.' },
    ]);
    expect(permissions.can).toHaveBeenCalledTimes(2);
    expect(permissions.can).toHaveBeenCalledWith(ADMIN, 'asset.write', { companyId: OTHER });
    // Selection is scoped to this integration's mapped companies.
    expect(prisma.integrationSyncRecord.findMany.mock.calls[0]![0].where).toMatchObject({
      companyId: { in: [COMPANY, OTHER] }, companyMapping: { integrationId: 'int-1' },
    });
    // The skipped company's record is never read or written.
    expect(prisma.integrationSyncRecord.findFirst).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: OTHER }) }));
    expect(assets.update).not.toHaveBeenCalled();
    // One in-transaction row per resolved item plus one summary row.
    expect(audit.logWithClient).toHaveBeenCalledTimes(2);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenLastCalledWith(expect.objectContaining({
      action: 'integration.difference.resolve_bulk',
      entityType: 'Integration',
      entityId: 'int-1',
      after: { choice: 'local', mode: 'items', companyId: null, applied: 2, skipped: 2, failed: 0 },
    }));
  });

  it('selects by the company filter after the cursor, capped at 500 without splitting a record', async () => {
    const rows = [row(id(1), COMPANY, [FIELD, FIELD_2]), ...Array.from({ length: 500 }, (_, i) => row(id(i + 2)))];
    const { service, prisma } = bulkSetup(rows);
    const result = await service.resolveBulk(ADMIN, 'int-1', { choice: 'local', filter: { companyId: COMPANY, cursor: id(0) } }, META);
    // 2 + 498 = 500; the next record would pass the cap, so the batch ends before it.
    expect(result.applied).toBe(500);
    expect(result.nextCursor).toBe(id(499));
    const query = prisma.integrationSyncRecord.findMany.mock.calls[0]![0];
    expect(query.where).toMatchObject({ companyId: { in: [COMPANY] }, id: { gt: id(0) }, companyMapping: { integrationId: 'int-1' } });
    expect(query.take).toBe(501);
    expect(query.orderBy).toEqual({ id: 'asc' });
  });

  it('keeps a record whole in a filter batch even when it alone holds more than 500 differences', async () => {
    const fields = Array.from({ length: 501 }, (_, i) => id(1000 + i));
    const { service } = bulkSetup([row(id(1), COMPANY, fields), row(id(2))]);
    const result = await service.resolveBulk(ADMIN, 'int-1', { choice: 'local', filter: { companyId: COMPANY } }, META);
    expect(result).toMatchObject({ applied: 501, nextCursor: id(1) });
  });

  it('reports an item whose audit row fails as failed, uncommitted, and audits each success once', async () => {
    const rows = [row(id(1)), row(id(2)), row(id(3))];
    const { service, audit, commits } = bulkSetup(rows);
    audit.logWithClient
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('audit down')) // record 2
      .mockResolvedValue(undefined);
    const result = await service.resolveBulk(ADMIN, 'int-1', { choice: 'local', items: rows.map((r) => ({ syncRecordId: r.id, assetFieldId: FIELD })) }, META);
    expect(result.applied).toBe(2);
    expect(result.failed).toEqual([{ syncRecordId: id(2), assetFieldId: FIELD, assetName: 'Asset 02', reason: 'Could not resolve this difference.' }]);
    expect(commits()).toBe(2);
    const perItem = audit.logWithClient.mock.calls.map(([, entry]) => entry as { action: string; after: { syncRecordId: string } });
    expect(perItem.every((entry) => entry.action === 'integration.difference.resolve')).toBe(true);
    expect(perItem.map((entry) => entry.after.syncRecordId)).toEqual([id(1), id(2), id(3)]);
    expect(audit.log).toHaveBeenCalledTimes(1); // summary only
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ after: expect.objectContaining({ applied: 2, failed: 1 }) }));
  });

  it('ends the filter walk when the last batch fits', async () => {
    const { service } = bulkSetup([row(id(1)), row(id(2), OTHER)]);
    const result = await service.resolveBulk(ADMIN, 'int-1', { choice: 'local', filter: {} }, META);
    expect(result).toMatchObject({ applied: 2, nextCursor: null });
  });

  it('404s a filter company that is not mapped, and an unknown integration', async () => {
    const { service, prisma } = bulkSetup([], [COMPANY]);
    await expect(service.resolveBulk(ADMIN, 'int-1', { choice: 'local', filter: { companyId: OTHER } }, META))
      .rejects.toBeInstanceOf(NotFoundException);
    prisma.integration.findUnique.mockResolvedValue(null);
    await expect(service.resolveBulk(ADMIN, 'nope', { choice: 'local', filter: {} }, META)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports partial failures with fixed reasons and keeps going', async () => {
    const rows = [row(id(1)), row(id(2)), row(id(3)), row(id(4))];
    const { service, prisma, assets } = bulkSetup(rows);
    prisma.integrationSyncRecord.updateMany
      .mockResolvedValueOnce({ count: 0 }) // a sync rewrote record 1
      .mockResolvedValue({ count: 1 });
    assets.update
      .mockRejectedValueOnce(new BadRequestException({ error: 'ValidationError' })) // record 2
      .mockRejectedValueOnce(new Error('db down: internal detail')) // record 3
      .mockResolvedValue({});
    const result = await service.resolveBulk(ADMIN, 'int-1', { choice: 'source', items: rows.map((r) => ({ syncRecordId: r.id, assetFieldId: FIELD })) }, META);
    expect(result.applied).toBe(1);
    expect(result.failed.map((f) => [f.syncRecordId, f.reason])).toEqual([
      [id(1), 'The integration synced this asset just now. Try again.'],
      [id(2), 'The source value does not fit this field.'],
      [id(3), 'Could not resolve this difference.'],
    ]);
    expect(JSON.stringify(result)).not.toContain('internal detail');
  });

  it('denies client users before reading anything', async () => {
    const { service, prisma } = bulkSetup([row(id(1))]);
    await expect(service.resolveBulk({ id: 'u', role: 'CLIENT_USER' } as never, 'int-1', { choice: 'local', filter: {} }, META))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.integration.findUnique).not.toHaveBeenCalled();
  });

  it('is gated by integration.manage, and the body takes items or a filter, at most 500 items', () => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, IntegrationDifferencesController.prototype.resolveBulk)).toEqual({
      action: 'integration.manage',
      companyIdFrom: undefined,
    });
    const item = { syncRecordId: RECORD, assetFieldId: FIELD };
    expect(resolveIntegrationDifferencesBulkSchema.safeParse({ choice: 'source', items: [item] }).success).toBe(true);
    expect(resolveIntegrationDifferencesBulkSchema.safeParse({ choice: 'local', filter: { companyId: COMPANY } }).success).toBe(true);
    expect(resolveIntegrationDifferencesBulkSchema.safeParse({ choice: 'local' }).success).toBe(false);
    expect(resolveIntegrationDifferencesBulkSchema.safeParse({ choice: 'local', items: [item], filter: {} }).success).toBe(false);
    expect(resolveIntegrationDifferencesBulkSchema.safeParse({ choice: 'local', items: Array(501).fill(item) }).success).toBe(false);
  });
});
