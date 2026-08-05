import { BadRequestException } from '@nestjs/common';
import type { BackupConfigInput } from '@weavestream/shared';
import { BackupsService } from './backups.service.js';

/**
 * Validation surface only: the shared zod schemas check shape, so a
 * shape-valid but semantically broken cron/timezone must be rejected
 * here — before the Prisma write — or the registrar's error-swallowing
 * `reassert` would report a successful save for a schedule BullMQ can
 * never register (or, worse for timezones, one that silently fires at
 * the wrong local time: BullMQ's cron parser accepts unknown zone
 * names). The gate applies only while the resulting config is
 * enabled: disabling a malformed legacy row must always succeed.
 */
describe('BackupsService config validation', () => {
  const baseRow = {
    id: 'cfg-1',
    name: 'Nightly',
    enabled: true,
    cron: '0 3 * * *',
    timezone: null as string | null,
    retention: { keepLast: 3, daily: 7, weekly: 4, monthly: 12 },
    notifyEmails: [] as string[],
    notifyOnSuccess: false,
    lastRunAt: null as Date | null,
    createdBy: 'user-1',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  };

  function setup(existing: typeof baseRow | null = baseRow) {
    const prisma = {
      backupConfig: {
        create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...baseRow,
          ...data,
        })),
        update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          ...baseRow,
          ...data,
        })),
        findUnique: jest.fn().mockResolvedValue(existing),
      },
    };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const queues = { get: jest.fn() };
    const env = { values: { BACKUP_STORAGE_DIR: '/var/lib/weavestream/backup' } };
    const registrar = { reassert: jest.fn().mockResolvedValue(undefined) };
    const service = new BackupsService(
      prisma as never,
      audit as never,
      queues as never,
      env as never,
      registrar as never,
    );
    return { service, prisma, audit, registrar };
  }

  function input(overrides: Partial<BackupConfigInput> = {}): BackupConfigInput {
    return {
      name: 'Nightly',
      enabled: true,
      cron: '0 3 * * *',
      timezone: null,
      retention: { keepLast: 3, daily: 7, weekly: 4, monthly: 12 },
      notifyEmails: [],
      notifyOnSuccess: false,
      ...overrides,
    };
  }

  const actor = { id: 'user-1' } as never;
  const meta = { ip: '127.0.0.1', userAgent: 'jest' } as never;

  describe('createConfig', () => {
    it('rejects a shape-valid but out-of-range cron before any write', async () => {
      const { service, prisma, audit, registrar } = setup();

      await expect(
        service.createConfig(actor, input({ cron: '99 99 * * *' }), meta),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.createConfig(actor, input({ cron: '99 99 * * *' }), meta),
      ).rejects.toThrow(/Invalid cron pattern/);

      expect(prisma.backupConfig.create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(registrar.reassert).not.toHaveBeenCalled();
    });

    it('rejects an unknown IANA timezone before any write', async () => {
      const { service, prisma } = setup();

      await expect(
        service.createConfig(actor, input({ timezone: 'Foo/Bar' }), meta),
      ).rejects.toThrow(/Unknown timezone "Foo\/Bar"/);

      expect(prisma.backupConfig.create).not.toHaveBeenCalled();
    });

    it('rejects a shape-valid cron that can never fire', async () => {
      const { service, prisma } = setup();

      await expect(
        service.createConfig(actor, input({ cron: '0 0 30 2 *' }), meta),
      ).rejects.toThrow(/Invalid cron pattern/);

      expect(prisma.backupConfig.create).not.toHaveBeenCalled();
    });

    it('accepts a valid cron with null timezone and reasserts the schedule', async () => {
      const { service, prisma, registrar } = setup();

      const dto = await service.createConfig(actor, input(), meta);

      expect(prisma.backupConfig.create).toHaveBeenCalledTimes(1);
      expect(registrar.reassert).toHaveBeenCalledWith('cfg-1');
      expect(dto.cron).toBe('0 3 * * *');
      expect(dto.timezone).toBeNull();
    });

    it('accepts a valid explicit timezone', async () => {
      const { service, prisma } = setup();

      await service.createConfig(
        actor,
        input({ timezone: 'America/New_York' }),
        meta,
      );

      expect(prisma.backupConfig.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateConfig', () => {
    it('validates the merged result: a timezone-only patch onto a valid cron is still rejected', async () => {
      const { service, prisma, registrar } = setup();

      await expect(
        service.updateConfig(actor, 'cfg-1', { timezone: 'Foo/Bar' }, meta),
      ).rejects.toThrow(/Unknown timezone/);

      expect(prisma.backupConfig.update).not.toHaveBeenCalled();
      expect(registrar.reassert).not.toHaveBeenCalled();
    });

    it('rejects an out-of-range cron patch before any write', async () => {
      const { service, prisma } = setup();

      await expect(
        service.updateConfig(actor, 'cfg-1', { cron: '0 25 * * *' }, meta),
      ).rejects.toThrow(/Invalid cron pattern/);

      expect(prisma.backupConfig.update).not.toHaveBeenCalled();
    });

    it('accepts a valid cron patch and reasserts the schedule', async () => {
      const { service, prisma, registrar } = setup();

      await service.updateConfig(actor, 'cfg-1', { cron: '30 2 * * *' }, meta);

      expect(prisma.backupConfig.update).toHaveBeenCalledTimes(1);
      expect(registrar.reassert).toHaveBeenCalledWith('cfg-1');
    });

    it('disables a malformed legacy config without validating it', async () => {
      // Row predates semantic validation: both fields are broken.
      const { service, prisma, registrar } = setup({
        ...baseRow,
        cron: '99 99 * * *',
        timezone: 'Foo/Bar',
      });

      await service.updateConfig(actor, 'cfg-1', { enabled: false }, meta);

      expect(prisma.backupConfig.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'cfg-1' },
          data: expect.objectContaining({ enabled: false }),
        }),
      );
      expect(registrar.reassert).toHaveBeenCalledWith('cfg-1');
    });

    it('still gates re-enabling a malformed legacy config', async () => {
      const { service, prisma, registrar } = setup({
        ...baseRow,
        cron: '99 99 * * *',
        enabled: false,
      });

      await expect(
        service.updateConfig(actor, 'cfg-1', { enabled: true }, meta),
      ).rejects.toThrow(/Invalid cron pattern/);

      expect(prisma.backupConfig.update).not.toHaveBeenCalled();
      expect(registrar.reassert).not.toHaveBeenCalled();
    });
  });
});
