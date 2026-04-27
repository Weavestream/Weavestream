import { ConflictException, NotFoundException } from '@nestjs/common';
import { TagsService } from './tags.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

type MockTagRow = {
  id: string;
  name: string;
  nameLower: string;
  createdAt: Date;
  updatedAt: Date;
};

function nowRow(name: string, id = 't-1'): MockTagRow {
  return {
    id,
    name,
    nameLower: name.toLowerCase(),
    createdAt: new Date('2026-04-01T00:00:00Z'),
    updatedAt: new Date('2026-04-01T00:00:00Z'),
  };
}

function makePrisma() {
  return {
    tag: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  };
}

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

const ACTOR: AuthedUser = {
  id: 'u-1',
  email: 'op@example.com',
  role: 'OPERATOR',
} as unknown as AuthedUser;

const META = { ip: '127.0.0.1', userAgent: 'jest' };

describe('TagsService', () => {
  describe('list', () => {
    it('default limit is 50 and ordered by nameLower', async () => {
      const prisma = makePrisma();
      const audit = makeAudit();
      prisma.tag.findMany.mockResolvedValue([nowRow('Alpha', 't-1')]);
      const svc = new TagsService(prisma as never, audit as never);
      await svc.list();
      expect(prisma.tag.findMany).toHaveBeenCalledWith({
        where: {},
        orderBy: [{ nameLower: 'asc' }],
        take: 50,
        skip: 0,
      });
    });

    it('clamps limit to 200 max', async () => {
      const prisma = makePrisma();
      prisma.tag.findMany.mockResolvedValue([]);
      const svc = new TagsService(prisma as never, makeAudit() as never);
      await svc.list({ limit: 5000 });
      expect(prisma.tag.findMany.mock.calls[0]![0]).toMatchObject({ take: 200 });
    });

    it('searches case-insensitively on nameLower', async () => {
      const prisma = makePrisma();
      prisma.tag.findMany.mockResolvedValue([]);
      const svc = new TagsService(prisma as never, makeAudit() as never);
      await svc.list({ q: ' Prod ' });
      expect(prisma.tag.findMany.mock.calls[0]![0]).toMatchObject({
        where: { nameLower: { contains: 'prod' } },
      });
    });
  });

  describe('upsertByName', () => {
    it('lowercases the key and preserves the input casing on create', async () => {
      const prisma = makePrisma();
      prisma.tag.upsert.mockResolvedValue({ id: 't-1' });
      const svc = new TagsService(prisma as never, makeAudit() as never);
      const id = await svc.upsertByName('  Production  ');
      expect(id).toBe('t-1');
      expect(prisma.tag.upsert).toHaveBeenCalledWith({
        where: { nameLower: 'production' },
        create: { name: 'Production', nameLower: 'production' },
        update: {},
        select: { id: true },
      });
    });

    it('rejects empty names', async () => {
      const svc = new TagsService(makePrisma() as never, makeAudit() as never);
      await expect(svc.upsertByName('   ')).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('uses the supplied transaction client when provided', async () => {
      const prisma = makePrisma();
      const tx = { tag: { upsert: jest.fn().mockResolvedValue({ id: 't-9' }) } };
      const svc = new TagsService(prisma as never, makeAudit() as never);
      const id = await svc.upsertByName('Critical', tx as never);
      expect(id).toBe('t-9');
      expect(prisma.tag.upsert).not.toHaveBeenCalled();
      expect(tx.tag.upsert).toHaveBeenCalled();
    });
  });

  describe('rename', () => {
    it('throws NotFound when the tag is missing', async () => {
      const prisma = makePrisma();
      prisma.tag.findUnique.mockResolvedValue(null);
      const svc = new TagsService(prisma as never, makeAudit() as never);
      await expect(svc.rename(ACTOR, 't-x', 'Foo', META)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('rejects with 409 when nameLower collides with a different row', async () => {
      const prisma = makePrisma();
      prisma.tag.findUnique
        .mockResolvedValueOnce(nowRow('Production', 't-1'))
        .mockResolvedValueOnce(nowRow('staging', 't-2'));
      const svc = new TagsService(prisma as never, makeAudit() as never);
      await expect(
        svc.rename(ACTOR, 't-1', 'Staging', META),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tag.update).not.toHaveBeenCalled();
    });

    it('updates name + nameLower and writes an audit row', async () => {
      const prisma = makePrisma();
      const audit = makeAudit();
      prisma.tag.findUnique
        .mockResolvedValueOnce(nowRow('Production', 't-1'))
        .mockResolvedValueOnce(null);
      prisma.tag.update.mockResolvedValue(nowRow('Prod', 't-1'));
      const svc = new TagsService(prisma as never, audit as never);
      const out = await svc.rename(ACTOR, 't-1', 'Prod', META);
      expect(prisma.tag.update).toHaveBeenCalledWith({
        where: { id: 't-1' },
        data: { name: 'Prod', nameLower: 'prod' },
      });
      expect(out.name).toBe('Prod');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tag.rename',
          entityType: 'Tag',
          entityId: 't-1',
          before: { name: 'Production' },
          after: { name: 'Prod' },
        }),
      );
    });

    it('allows a casing-only rename (same nameLower) without checking for a duplicate', async () => {
      const prisma = makePrisma();
      prisma.tag.findUnique.mockResolvedValueOnce(nowRow('production', 't-1'));
      prisma.tag.update.mockResolvedValue(nowRow('Production', 't-1'));
      const svc = new TagsService(prisma as never, makeAudit() as never);
      await svc.rename(ACTOR, 't-1', 'Production', META);
      expect(prisma.tag.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.tag.update).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('throws NotFound when missing', async () => {
      const prisma = makePrisma();
      prisma.tag.findUnique.mockResolvedValue(null);
      const svc = new TagsService(prisma as never, makeAudit() as never);
      await expect(svc.remove(ACTOR, 't-x', META)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('hard-deletes and logs an audit row', async () => {
      const prisma = makePrisma();
      const audit = makeAudit();
      prisma.tag.findUnique.mockResolvedValueOnce(nowRow('Production', 't-1'));
      prisma.tag.delete.mockResolvedValue(undefined);
      const svc = new TagsService(prisma as never, audit as never);
      await svc.remove(ACTOR, 't-1', META);
      expect(prisma.tag.delete).toHaveBeenCalledWith({ where: { id: 't-1' } });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'tag.delete',
          entityType: 'Tag',
          entityId: 't-1',
          before: { name: 'Production' },
          after: null,
        }),
      );
    });
  });

  describe('getMany', () => {
    it('returns an empty map for an empty input', async () => {
      const svc = new TagsService(makePrisma() as never, makeAudit() as never);
      const out = await svc.getMany([]);
      expect(out.size).toBe(0);
    });

    it('dedupes ids and indexes by id', async () => {
      const prisma = makePrisma();
      prisma.tag.findMany.mockResolvedValue([
        {
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Production',
          nameLower: 'production',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: '22222222-2222-2222-2222-222222222222',
          name: 'Staging',
          nameLower: 'staging',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const svc = new TagsService(prisma as never, makeAudit() as never);
      const out = await svc.getMany([
        '11111111-1111-1111-1111-111111111111',
        '11111111-1111-1111-1111-111111111111',
        '22222222-2222-2222-2222-222222222222',
      ]);
      expect(prisma.tag.findMany.mock.calls[0]![0]).toMatchObject({
        where: {
          id: {
            in: [
              '11111111-1111-1111-1111-111111111111',
              '22222222-2222-2222-2222-222222222222',
            ],
          },
        },
      });
      expect(out.get('11111111-1111-1111-1111-111111111111')?.name).toBe(
        'Production',
      );
      expect(out.get('22222222-2222-2222-2222-222222222222')?.name).toBe(
        'Staging',
      );
    });

    it('drops legacy non-UUID strings without hitting Prisma', async () => {
      // Pre-migration TAGS fields stored raw names like "production". Those
      // would crash Prisma's UUID column with P2023 if they reached
      // `findMany`. The service must filter them before issuing the query.
      const prisma = makePrisma();
      prisma.tag.findMany.mockResolvedValue([]);
      const svc = new TagsService(prisma as never, makeAudit() as never);
      const out = await svc.getMany(['production', 'staging', 'not-a-uuid']);
      expect(prisma.tag.findMany).not.toHaveBeenCalled();
      expect(out.size).toBe(0);
    });

    it('keeps the UUID subset and skips the legacy strings in a mixed input', async () => {
      const prisma = makePrisma();
      prisma.tag.findMany.mockResolvedValue([
        {
          id: '11111111-1111-1111-1111-111111111111',
          name: 'Production',
          nameLower: 'production',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      const svc = new TagsService(prisma as never, makeAudit() as never);
      const out = await svc.getMany([
        'production',
        '11111111-1111-1111-1111-111111111111',
      ]);
      expect(prisma.tag.findMany.mock.calls[0]![0]).toMatchObject({
        where: { id: { in: ['11111111-1111-1111-1111-111111111111'] } },
      });
      expect(out.size).toBe(1);
    });
  });
});
