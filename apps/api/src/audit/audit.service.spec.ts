import { AuditLogService } from './audit.service.js';

function makePrisma() {
  return {
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
  };
}

describe('AuditLogService.logChange (Phase 9a)', () => {
  it('writes a row containing only the changed fields', async () => {
    const prisma = makePrisma();
    const svc = new AuditLogService(prisma as never);

    await svc.logChange({
      actorId: 'a',
      action: 'company.update',
      entityType: 'Company',
      entityId: 'c1',
      companyId: 'c1',
      before: { name: 'Old', slug: 'old', notes: 'same' },
      after: { name: 'New', slug: 'old', notes: 'same' },
      fields: ['name', 'slug', 'notes'],
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const args = prisma.auditLog.create.mock.calls[0]![0] as {
      data: { before: unknown; after: unknown };
    };
    expect(args.data.before).toEqual({ name: 'Old' });
    expect(args.data.after).toEqual({ name: 'New' });
  });

  it('is a no-op when nothing changed', async () => {
    const prisma = makePrisma();
    const svc = new AuditLogService(prisma as never);

    await svc.logChange({
      actorId: 'a',
      action: 'company.update',
      entityType: 'Company',
      entityId: 'c1',
      companyId: 'c1',
      before: { name: 'Same' },
      after: { name: 'Same' },
      fields: ['name'],
    });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('treats Date vs ISO string as equal', async () => {
    const prisma = makePrisma();
    const svc = new AuditLogService(prisma as never);

    const d = new Date('2024-01-01T00:00:00.000Z');
    await svc.logChange({
      actorId: 'a',
      action: 'entity.update',
      entityType: 'X',
      entityId: 'x',
      before: { t: d },
      after: { t: d.toISOString() },
      fields: ['t'],
    });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('treats undefined and null as equivalent "missing"', async () => {
    const prisma = makePrisma();
    const svc = new AuditLogService(prisma as never);

    await svc.logChange({
      actorId: 'a',
      action: 'entity.update',
      entityType: 'X',
      entityId: 'x',
      before: { foo: null },
      after: { foo: undefined },
      fields: ['foo'],
    });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('falls back to the union of keys when `fields` is omitted', async () => {
    const prisma = makePrisma();
    const svc = new AuditLogService(prisma as never);

    await svc.logChange({
      actorId: 'a',
      action: 'entity.update',
      entityType: 'X',
      entityId: 'x',
      before: { a: 1, b: 2 },
      after: { a: 1, c: 3 },
    });

    const args = prisma.auditLog.create.mock.calls[0]![0] as {
      data: { before: Record<string, unknown>; after: Record<string, unknown> };
    };
    expect(Object.keys(args.data.before).sort()).toEqual(['b', 'c']);
    expect(args.data.before).toEqual({ b: 2, c: null });
    expect(args.data.after).toEqual({ b: null, c: 3 });
  });

  it('deep-compares nested objects by JSON shape', async () => {
    const prisma = makePrisma();
    const svc = new AuditLogService(prisma as never);

    await svc.logChange({
      actorId: 'a',
      action: 'entity.update',
      entityType: 'X',
      entityId: 'x',
      before: { meta: { foo: 1, bar: 2 } },
      after: { meta: { foo: 1, bar: 2 } },
      fields: ['meta'],
    });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
