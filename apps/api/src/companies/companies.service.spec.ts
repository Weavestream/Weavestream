import { BadRequestException, ConflictException } from '@nestjs/common';
import { CompaniesService } from './companies.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

/**
 * Phase 9a service coverage. These are pure unit tests backed by
 * hand-mocked `Prisma`, `Audit`, and `Minio` collaborators. We focus
 * on the branches that are purely business logic and don't touch the
 * DB in a meaningful way:
 *
 *   - cycle detection when setting a parent company
 *   - self-parent rejection
 *   - cross-tenant guard on logo uploads
 *   - diff-based audit writes (no-op updates produce no audit row)
 *   - website normalisation
 */

const ACTOR: AuthedUser = {
  id: 'actor-1',
  role: 'SUPER_ADMIN',
  globalAccess: null,
  platformCapabilities: [],
  email: 'a@x',
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

const META = { ip: '127.0.0.1', userAgent: 'jest' };

type CompanyRow = Record<string, unknown> & {
  id: string;
  name: string;
  slug: string;
  parentCompanyId: string | null;
  archivedAt: Date | null;
};

function makeCompany(overrides: Partial<CompanyRow> = {}): CompanyRow {
  return {
    id: overrides.id ?? 'c-1',
    name: 'Acme',
    slug: 'acme',
    notes: null,
    quickNotes: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    type: 'CLIENT',
    parentCompanyId: null,
    logoUploadId: null,
    contactName: null,
    contactTitle: null,
    contactEmail: null,
    contactPhone: null,
    generalEmail: null,
    phone: null,
    fax: null,
    website: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    region: null,
    postalCode: null,
    country: null,
    ...overrides,
  };
}

function makePrisma(companies: Record<string, CompanyRow> = {}) {
  return {
    company: {
      findUnique: jest.fn(({ where }: { where: { id?: string; slug?: string } }) => {
        if (where.id) return Promise.resolve(companies[where.id] ?? null);
        if (where.slug) {
          return Promise.resolve(
            Object.values(companies).find((c) => c.slug === where.slug) ?? null,
          );
        }
        return Promise.resolve(null);
      }),
      update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<CompanyRow> }) => {
        const next = { ...companies[where.id]!, ...data };
        companies[where.id] = next;
        return Promise.resolve(next);
      }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    membership: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    upload: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeAudit() {
  return {
    log: jest.fn().mockResolvedValue(undefined),
    logChange: jest.fn().mockResolvedValue(undefined),
  };
}

function makeCache() {
  return { invalidateMany: jest.fn().mockResolvedValue(undefined) };
}

function makeMinio() {
  return {
    presignGet: jest
      .fn()
      .mockResolvedValue({ url: 'https://signed.example/obj', expiresAt: new Date() }),
  };
}

describe('CompaniesService parent hierarchy', () => {
  it('rejects self-parent', async () => {
    const companies = { a: makeCompany({ id: 'a' }) };
    const prisma = makePrisma(companies);
    const svc = new CompaniesService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeMinio() as never,
    );

    await expect(
      svc.update(ACTOR, 'a', { parentCompanyId: 'a' }, META),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown parent id', async () => {
    const companies = { a: makeCompany({ id: 'a' }) };
    const prisma = makePrisma(companies);
    const svc = new CompaniesService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeMinio() as never,
    );

    await expect(
      svc.update(ACTOR, 'a', { parentCompanyId: 'ghost' }, META),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an assignment that would introduce a cycle', async () => {
    // Topology: a → b → c. If we try to parent `a` under `c`, the chain
    // c → a → b → c loops back to itself.
    const companies = {
      a: makeCompany({ id: 'a', parentCompanyId: null }),
      b: makeCompany({ id: 'b', parentCompanyId: 'a' }),
      c: makeCompany({ id: 'c', parentCompanyId: 'b' }),
    };
    const prisma = makePrisma(companies);
    const svc = new CompaniesService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeMinio() as never,
    );

    await expect(
      svc.update(ACTOR, 'a', { parentCompanyId: 'c' }, META),
    ).rejects.toThrow(/circular hierarchy/i);
  });

  it('allows a legitimate parent assignment', async () => {
    const companies = {
      a: makeCompany({ id: 'a' }),
      b: makeCompany({ id: 'b' }),
    };
    const prisma = makePrisma(companies);
    const audit = makeAudit();
    const svc = new CompaniesService(
      prisma as never,
      audit as never,
      makeCache() as never,
      makeMinio() as never,
    );

    const out = await svc.update(ACTOR, 'b', { parentCompanyId: 'a' }, META);
    expect(out.parentCompanyId).toBe('a');
    expect(audit.logChange).toHaveBeenCalledTimes(1);
  });
});

describe('CompaniesService logo guard', () => {
  function setup(upload: null | { companyId: string; isImage: boolean; deletedAt: Date | null }) {
    const companies = { c1: makeCompany({ id: 'c1' }) };
    const prisma = makePrisma(companies);
    prisma.upload.findUnique.mockResolvedValue(
      upload === null ? null : { id: 'u-1', ...upload },
    );
    return {
      prisma,
      svc: new CompaniesService(
        prisma as never,
        makeAudit() as never,
        makeCache() as never,
        makeMinio() as never,
      ),
    };
  }

  it('rejects a logo upload that belongs to another tenant', async () => {
    const { svc } = setup({ companyId: 'other', isImage: true, deletedAt: null });
    await expect(
      svc.update(ACTOR, 'c1', { logoUploadId: 'u-1' }, META),
    ).rejects.toThrow(/different company/i);
  });

  it('rejects non-image uploads', async () => {
    const { svc } = setup({ companyId: 'c1', isImage: false, deletedAt: null });
    await expect(
      svc.update(ACTOR, 'c1', { logoUploadId: 'u-1' }, META),
    ).rejects.toThrow(/must be an image/i);
  });

  it('rejects soft-deleted uploads', async () => {
    const { svc } = setup({
      companyId: 'c1',
      isImage: true,
      deletedAt: new Date(),
    });
    await expect(
      svc.update(ACTOR, 'c1', { logoUploadId: 'u-1' }, META),
    ).rejects.toThrow(/not found/i);
  });

  it('accepts a valid same-tenant image upload', async () => {
    const { svc } = setup({ companyId: 'c1', isImage: true, deletedAt: null });
    const out = await svc.update(ACTOR, 'c1', { logoUploadId: 'u-1' }, META);
    expect(out.logoUploadId).toBe('u-1');
  });

  it('accepts clearing the logo (null)', async () => {
    const companies = { c1: makeCompany({ id: 'c1', logoUploadId: 'u-1' as never }) };
    const prisma = makePrisma(companies);
    const svc = new CompaniesService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeMinio() as never,
    );
    const out = await svc.update(ACTOR, 'c1', { logoUploadId: null }, META);
    expect(out.logoUploadId).toBeNull();
  });
});

describe('CompaniesService slug uniqueness', () => {
  it('throws ConflictException when the new slug is taken', async () => {
    const companies = {
      a: makeCompany({ id: 'a', slug: 'a' }),
      b: makeCompany({ id: 'b', slug: 'b' }),
    };
    const prisma = makePrisma(companies);
    const svc = new CompaniesService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeMinio() as never,
    );

    await expect(
      svc.update(ACTOR, 'a', { slug: 'b' }, META),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('CompaniesService website normalisation', () => {
  it('prepends https:// to a bare hostname', async () => {
    const companies = { c: makeCompany({ id: 'c' }) };
    const prisma = makePrisma(companies);
    const svc = new CompaniesService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeMinio() as never,
    );

    const out = await svc.update(ACTOR, 'c', { website: 'example.com' }, META);
    expect(out.website).toBe('https://example.com');
  });

  it('leaves a full URL untouched', async () => {
    const companies = { c: makeCompany({ id: 'c' }) };
    const prisma = makePrisma(companies);
    const svc = new CompaniesService(
      prisma as never,
      makeAudit() as never,
      makeCache() as never,
      makeMinio() as never,
    );

    const out = await svc.update(
      ACTOR,
      'c',
      { website: 'https://example.com/path' },
      META,
    );
    expect(out.website).toBe('https://example.com/path');
  });
});
