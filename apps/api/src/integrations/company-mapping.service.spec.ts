import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IntegrationCompanyMappingService } from './company-mapping.service.js';

describe('IntegrationCompanyMappingService', () => {
  const actor = { id: 'actor' } as never;
  const meta = { ip: '127.0.0.1', userAgent: 'jest' };
  const existing = {
    id: 'mapping', integrationId: 'integration', companyId: 'company-a',
    externalOrgId: 'org-1', externalOrgName: 'Acme', enabled: true, filter: {},
    createdAt: new Date('2026-07-14T00:00:00.000Z'), updatedAt: new Date('2026-07-14T00:00:00.000Z'),
    company: { name: 'Company A' },
  };

  function setup() {
    const prisma = {
      integration: { findUnique: jest.fn().mockResolvedValue({ id: 'integration' }) },
      company: { findUnique: jest.fn().mockResolvedValue({ id: 'company-a', archivedAt: null }) },
      integrationCompanyMapping: {
        findMany: jest.fn().mockResolvedValue([existing]),
        findFirst: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue(existing),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const audit = { log: jest.fn(), logChange: jest.fn() };
    return {
      service: new IntegrationCompanyMappingService(prisma as never, audit as never),
      prisma,
      audit,
    };
  }

  it('lists persisted mappings only and does not infer companies from source names', async () => {
    const { service, prisma } = setup();
    await expect(service.list('integration')).resolves.toHaveLength(1);
    expect(prisma.integrationCompanyMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { integrationId: 'integration' } }),
    );
    expect(prisma.company.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a duplicate external organization as a conflict', async () => {
    const { service, prisma } = setup();
    prisma.integrationCompanyMapping.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: '5.22.0' }),
    );

    await expect(service.create(actor, 'integration', {
      companyId: 'company-a', externalOrgId: 'org-1', enabled: true, filter: {},
    }, meta)).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects missing and archived companies before writing', async () => {
    const { service, prisma } = setup();
    prisma.company.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'archived', archivedAt: new Date() });

    await expect(service.create(actor, 'integration', {
      companyId: 'missing', externalOrgId: 'org-2', enabled: true, filter: {},
    }, meta)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.create(actor, 'integration', {
      companyId: 'archived', externalOrgId: 'org-3', enabled: true, filter: {},
    }, meta)).rejects.toThrow(/archived/i);
    expect(prisma.integrationCompanyMapping.create).not.toHaveBeenCalled();
  });

  it('rejects attempts to reassign a source organization to another company before a write', async () => {
    const { service, prisma, audit } = setup();

    await expect(service.update(actor, 'integration', 'mapping', {
      companyId: 'company-b',
    }, meta)).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.integrationCompanyMapping.updateMany).not.toHaveBeenCalled();
    expect(audit.logChange).not.toHaveBeenCalled();
  });

  it('keeps every update and lookup scoped to the mapping integration and company axis', async () => {
    const { service, prisma } = setup();

    await service.update(actor, 'integration', 'mapping', { enabled: false }, meta);

    expect(prisma.integrationCompanyMapping.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'mapping', integrationId: 'integration' } }),
    );
    expect(prisma.integrationCompanyMapping.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'mapping', companyId: 'company-a' } }),
    );
  });
});
