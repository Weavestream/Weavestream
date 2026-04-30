import { PrismaClient } from '@prisma/client';

/**
 * Phase 9 integration test for the `audit_log_no_update_delete` trigger
 * installed by migration `0032_audit_log_immutable`. Asserts that the
 * database itself rejects UPDATE / DELETE against `audit_log` regardless
 * of who issues the statement.
 *
 * Skipped automatically when `DATABASE_URL` is unset (e.g. local
 * `pnpm test` without a Postgres available). CI's `test` job spins up
 * Postgres, runs `prisma migrate deploy`, then runs the suite — so this
 * test is the canonical regression guard against the trigger being
 * accidentally dropped.
 */
const dbUrl = process.env.DATABASE_URL;
const describeIfDb = dbUrl ? describe : describe.skip;

describeIfDb('audit_log immutability (DB integration)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await prisma.$connect();

    // Sanity check: skip silently if migrations haven't been applied
    // yet against this database. Prevents misleading failures on
    // pre-Phase-9 branches.
    const triggers = await prisma.$queryRaw<Array<{ tgname: string }>>`
      SELECT tgname FROM pg_trigger
      WHERE tgname = 'audit_log_no_update_delete'
    `;
    if (triggers.length === 0) {
      throw new Error(
        'audit_log_no_update_delete trigger missing — run prisma migrate deploy first',
      );
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects UPDATE on audit_log with the documented error', async () => {
    // Wrap in a transaction so the seed INSERT rolls back when the
    // UPDATE throws — keeps the test idempotent without needing the
    // escape-hatch trigger-disable dance.
    await expect(
      prisma.$transaction(async (tx) => {
        const row = await tx.auditLog.create({
          data: {
            action: 'test.audit_log_immutable',
            entityType: 'Test',
            entityId: null,
          },
        });
        await tx.$executeRawUnsafe(
          `UPDATE audit_log SET action = 'spoofed' WHERE id = '${row.id}'::uuid`,
        );
      }),
    ).rejects.toThrow(/audit_log is append-only/);
  });

  it('rejects DELETE on audit_log with the documented error', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const row = await tx.auditLog.create({
          data: {
            action: 'test.audit_log_immutable',
            entityType: 'Test',
            entityId: null,
          },
        });
        await tx.$executeRawUnsafe(
          `DELETE FROM audit_log WHERE id = '${row.id}'::uuid`,
        );
      }),
    ).rejects.toThrow(/audit_log is append-only/);
  });

  it('still allows INSERT (the only legal write path)', async () => {
    // Verify the trigger doesn't accidentally cover INSERT. Clean up
    // via the documented escape hatch so the seed row doesn't pollute
    // the test database between runs.
    const created = await prisma.auditLog.create({
      data: {
        action: 'test.audit_log_immutable.insert',
        entityType: 'Test',
        entityId: null,
      },
    });
    expect(created.id).toBeTruthy();

    await prisma.$executeRawUnsafe(
      'ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete',
    );
    try {
      await prisma.$executeRawUnsafe(
        `DELETE FROM audit_log WHERE id = '${created.id}'::uuid`,
      );
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete',
      );
    }
  });
});
