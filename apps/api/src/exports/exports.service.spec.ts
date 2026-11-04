import { NotFoundException } from '@nestjs/common';
import { ExportsController } from './exports.controller.js';
import { ExportsService, mayReadExportJob } from './exports.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * An export job and its PDF belong to the user who started it. Job ids are
 * sequential, so "knowing the id" must never be enough (CLAUDE.md §1).
 */

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const COMPANY = '00000000-0000-4000-8000-0000000000c3';

function actor(id: string, role: AuthedUser['role'] = 'OPERATOR'): AuthedUser {
  return {
    id,
    email: `${id}@x`,
    role,
    globalAccess: role === 'OPERATOR' ? 'FULL' : null,
    platformCapabilities: ['EXPORT_CREATE'],
    sessionId: 's-1',
    mfaEnforcementCompletedAt: null,
    mfaPending: false,
    globalPasswordAccess: false,
  };
}

function setup(jobData: Record<string, unknown> | null) {
  const job = jobData
    ? {
        data: jobData,
        getState: jest.fn().mockResolvedValue('completed'),
        returnvalue: { companyId: COMPANY, storageKey: 'exports/x.pdf' },
      }
    : null;
  const queue = { getJob: jest.fn().mockResolvedValue(job) };
  const queues = { get: jest.fn().mockReturnValue(queue) };
  const storage = { headObject: jest.fn().mockResolvedValue({ size: 1 }) };
  const service = new ExportsService(
    queues as never,
    {} as never,
    storage as never,
    {} as never,
    {} as never,
  );
  return { service, storage };
}

const OWNED = { kind: 'export', exportId: 'e', companyId: COMPANY, includePasswords: true, requestedBy: USER_A };
const LEGACY = { kind: 'export', exportId: 'e', companyId: COMPANY, includePasswords: true };

describe('mayReadExportJob', () => {
  it('allows the requester and super admins only', () => {
    expect(mayReadExportJob(actor(USER_A), OWNED)).toBe(true);
    expect(mayReadExportJob(actor(USER_B), OWNED)).toBe(false);
    expect(mayReadExportJob(actor(USER_B, 'SUPER_ADMIN'), OWNED)).toBe(true);
  });

  it('gives an ownerless legacy job to super admins only', () => {
    expect(mayReadExportJob(actor(USER_A), LEGACY)).toBe(false);
    expect(mayReadExportJob(actor(USER_A, 'SUPER_ADMIN'), LEGACY)).toBe(true);
    expect(mayReadExportJob(actor(USER_A), null)).toBe(false);
  });
});

describe('ExportsService job access', () => {
  it("hides user A's export status and file from user B", async () => {
    const { service, storage } = setup(OWNED);
    await expect(service.getJobStatus(actor(USER_B), '7')).resolves.toEqual({ status: 'unknown' });
    await expect(service.resolveCompletedExport(actor(USER_B), '7')).resolves.toBeNull();
    // Nothing about the file is even looked up for a foreign job.
    expect(storage.headObject).not.toHaveBeenCalled();
  });

  it('serves the export to its requester and to a super admin', async () => {
    const { service } = setup(OWNED);
    const located = { companyId: COMPANY, storageKey: 'exports/x.pdf' };
    await expect(service.resolveCompletedExport(actor(USER_A), '7')).resolves.toEqual(located);
    await expect(
      service.resolveCompletedExport(actor(USER_B, 'SUPER_ADMIN'), '7'),
    ).resolves.toEqual(located);
    await expect(service.getJobStatus(actor(USER_A), '7')).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('returns 404-shaped results for an ownerless legacy job to an operator', async () => {
    const { service } = setup(LEGACY);
    await expect(service.getJobStatus(actor(USER_A), '7')).resolves.toEqual({ status: 'unknown' });
    await expect(service.resolveCompletedExport(actor(USER_A), '7')).resolves.toBeNull();
    await expect(
      service.resolveCompletedExport(actor(USER_A, 'SUPER_ADMIN'), '7'),
    ).resolves.not.toBeNull();
  });
});

describe('ExportsController job access', () => {
  const res = { setHeader: jest.fn() } as never;

  it("answers 404 for user A's job status and download to user B", async () => {
    const controller = new ExportsController(setup(OWNED).service);
    await expect(controller.status(actor(USER_B), '7')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.download(actor(USER_B), '7', res)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('answers 404 for an ownerless legacy job to an operator, and serves a super admin', async () => {
    const controller = new ExportsController(setup(LEGACY).service);
    await expect(controller.status(actor(USER_A), '7')).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.status(actor(USER_A, 'SUPER_ADMIN'), '7')).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('answers 404 for a job id that does not exist, the same as a foreign job', async () => {
    const controller = new ExportsController(setup(null).service);
    await expect(controller.status(actor(USER_A), '7')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns the status to the requester', async () => {
    const controller = new ExportsController(setup(OWNED).service);
    await expect(controller.status(actor(USER_A), '7')).resolves.toMatchObject({
      status: 'completed',
    });
  });
});
