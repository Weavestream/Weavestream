import { BadRequestException } from '@nestjs/common';
import { REQUIRE_PERMISSION_KEY } from '../rbac/require-permission.decorator.js';
import { REQUIRE_STEP_UP_KEY } from '../auth/step-up/require-step-up.decorator.js';
import { INTERACTIVE_ONLY_KEY } from '../auth/interactive-only.decorator.js';
import { IntegrationPriorityController } from './integration-priority.controller.js';
import { IntegrationPriorityService } from './integration-priority.service.js';

const meta = (key: string, target: object) => Reflect.getMetadata(key, target);

const actor = { id: '00000000-0000-4000-8000-000000000001', role: 'SUPER_ADMIN' } as never;
const reqMeta = { ip: '127.0.0.1', userAgent: 'jest' };

function setup(stored: unknown = null) {
  const tx = {
    systemSetting: {
      upsert: jest.fn().mockResolvedValue({ integrationPriority: stored }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const prisma = {
    systemSetting: { findUnique: jest.fn().mockResolvedValue({ integrationPriority: stored }) },
    $transaction: jest.fn(async (cb: (client: typeof tx) => Promise<unknown>) => cb(tx)),
  };
  const audit = { logWithClient: jest.fn().mockResolvedValue(undefined) };
  const drivers = {
    list: () => [
      { key: 'google-workspace', label: 'Google Workspace' },
      { key: 'microsoft-365', label: 'Microsoft 365' },
      { key: 'level', label: 'Level RMM' },
      { key: 'zz-new', label: 'New driver' },
    ],
  };
  const service = new IntegrationPriorityService(prisma as never, audit as never, drivers as never);
  return { service, prisma, tx, audit };
}

describe('IntegrationPriorityController security contract', () => {
  const proto = IntegrationPriorityController.prototype;

  it('reads with settings.manage', () => {
    expect(meta(REQUIRE_PERMISSION_KEY, proto.get)).toEqual({ action: 'settings.manage', companyIdFrom: undefined });
  });

  it('writes with settings.manage, step-up, and an interactive session', () => {
    expect(meta(REQUIRE_PERMISSION_KEY, proto.update)).toEqual({ action: 'settings.manage', companyIdFrom: undefined });
    expect(meta(REQUIRE_STEP_UP_KEY, proto.update)).toEqual({});
    expect(meta(INTERACTIVE_ONLY_KEY, proto.update)).toBe(true);
  });
});

describe('IntegrationPriorityService', () => {
  it('returns the default order for registered drivers, then the rest alphabetically', async () => {
    const { service } = setup();
    await expect(service.get()).resolves.toEqual({
      order: [
        { key: 'level', label: 'Level RMM' },
        { key: 'microsoft-365', label: 'Microsoft 365' },
        { key: 'google-workspace', label: 'Google Workspace' },
        { key: 'zz-new', label: 'New driver' },
      ],
    });
  });

  it('keeps a stored order and appends drivers registered since', async () => {
    const { service } = setup(['google-workspace', 'removed-driver', 'level']);
    const { order } = await service.get();
    expect(order.map((o) => o.key)).toEqual(['google-workspace', 'level', 'microsoft-365', 'zz-new']);
  });

  it('saves the order and audits before and after in the same transaction', async () => {
    const { service, tx, audit } = setup();
    await service.update(actor, { order: ['google-workspace', 'microsoft-365', 'level', 'zz-new'] }, reqMeta);
    expect(tx.systemSetting.update).toHaveBeenCalledWith({
      where: { id: 'singleton' },
      data: { integrationPriority: ['google-workspace', 'microsoft-365', 'level', 'zz-new'], updatedBy: expect.any(String) },
    });
    expect(audit.logWithClient).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: 'settings.integration_priority.update',
      entityType: 'SystemSetting',
      before: { order: ['level', 'microsoft-365', 'google-workspace', 'zz-new'] },
      after: { order: ['google-workspace', 'microsoft-365', 'level', 'zz-new'] },
    }));
  });

  it('refuses an unknown driver key and writes nothing', async () => {
    const { service, prisma, audit } = setup();
    await expect(service.update(actor, { order: ['level', 'not-a-driver'] }, reqMeta)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(audit.logWithClient).not.toHaveBeenCalled();
  });
});
