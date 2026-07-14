import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AssetsService, classifyIntegrationAssetChange } from './assets.service.js';

/**
 * Focused unit test for the FILE-field upload backfill that runs
 * inside the asset write transaction. The dropzone on the new-asset
 * form calls `upload.init` with no `assetId` (the asset doesn't exist
 * yet), which leaves the upload row with `attached_to_id = null`. The
 * helper is responsible for patching those rows once the asset save
 * commits so the photos gallery can deep-link back to the asset.
 *
 * We exercise the private helper directly via a typed escape hatch
 * rather than spinning up the whole AssetsService dependency graph
 * (audit / search-index / relations / passwords / stars / tags), since
 * the helper itself only depends on a Prisma TransactionClient.
 */
describe('AssetsService.linkFileFieldUploadsToAsset', () => {
  type Tx = { upload: { updateMany: jest.Mock } };

  function makeService(): {
    service: AssetsService;
    updateMany: jest.Mock;
    tx: Tx;
  } {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const tx: Tx = { upload: { updateMany } };
    const service = new AssetsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, updateMany, tx };
  }

  function fileField(slug: string) {
    return {
      id: `field-${slug}`,
      slug,
      fieldType: 'FILE',
      archivedAt: null,
    } as never;
  }

  function textField(slug: string) {
    return {
      id: `field-${slug}`,
      slug,
      fieldType: 'TEXT',
      archivedAt: null,
    } as never;
  }

  it('patches every FILE-field upload id with the asset id', async () => {
    const { service, updateMany, tx } = makeService();
    const layout = {
      fields: [fileField('photo'), fileField('docs'), textField('name')],
    };
    const values = {
      name: 'PC-01',
      photo: [
        { uploadId: 'u-1', filename: 'a.png', mimeType: 'image/png', sizeBytes: 1 },
      ],
      docs: [
        { uploadId: 'u-2', filename: 'b.pdf', mimeType: 'application/pdf', sizeBytes: 1 },
        { uploadId: 'u-3', filename: 'c.pdf', mimeType: 'application/pdf', sizeBytes: 1 },
      ],
    };

    await (
      service as unknown as {
        linkFileFieldUploadsToAsset: (
          tx: unknown,
          companyId: string,
          assetId: string,
          layout: unknown,
          values: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).linkFileFieldUploadsToAsset(tx, 'c1', 'asset-1', layout, values);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0][0] as {
      where: {
        id: { in: string[] };
        companyId: string;
        attachedToType: string;
        attachedToId: null;
        deletedAt: null;
      };
      data: { attachedToId: string };
    };
    expect(call.where.companyId).toBe('c1');
    expect(call.where.attachedToType).toBe('asset');
    expect(call.where.attachedToId).toBeNull();
    expect(call.where.deletedAt).toBeNull();
    expect(call.where.id.in.sort()).toEqual(['u-1', 'u-2', 'u-3']);
    expect(call.data.attachedToId).toBe('asset-1');
  });

  it('is a no-op when there are no FILE fields with uploads', async () => {
    const { service, updateMany, tx } = makeService();
    const layout = { fields: [fileField('photo'), textField('name')] };
    const values = { name: 'PC-01', photo: [] };

    await (
      service as unknown as {
        linkFileFieldUploadsToAsset: (
          tx: unknown,
          companyId: string,
          assetId: string,
          layout: unknown,
          values: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).linkFileFieldUploadsToAsset(tx, 'c1', 'asset-1', layout, values);

    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ignores malformed FILE entries that lack uploadId', async () => {
    const { service, updateMany, tx } = makeService();
    const layout = { fields: [fileField('photo')] };
    const values = {
      photo: [
        { filename: 'orphan.png' }, // missing uploadId — skip
        { uploadId: 'u-real', filename: 'ok.png', mimeType: 'image/png', sizeBytes: 1 },
      ],
    };

    await (
      service as unknown as {
        linkFileFieldUploadsToAsset: (
          tx: unknown,
          companyId: string,
          assetId: string,
          layout: unknown,
          values: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).linkFileFieldUploadsToAsset(tx, 'c1', 'asset-1', layout, values);

    expect(updateMany).toHaveBeenCalledTimes(1);
    const call = updateMany.mock.calls[0][0] as { where: { id: { in: string[] } } };
    expect(call.where.id.in).toEqual(['u-real']);
  });

  it('only patches uploads that are still unowned (attached_to_id IS NULL)', async () => {
    const { service, updateMany, tx } = makeService();
    const layout = { fields: [fileField('photo')] };
    const values = {
      photo: [
        { uploadId: 'u-1', filename: 'a.png', mimeType: 'image/png', sizeBytes: 1 },
      ],
    };

    await (
      service as unknown as {
        linkFileFieldUploadsToAsset: (
          tx: unknown,
          companyId: string,
          assetId: string,
          layout: unknown,
          values: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).linkFileFieldUploadsToAsset(tx, 'c1', 'asset-1', layout, values);

    const call = updateMany.mock.calls[0][0] as {
      where: { attachedToId: null };
    };
    // The clause is the load-bearing safety: never claim an upload
    // that already belongs to a different asset.
    expect(call.where.attachedToId).toBeNull();
  });
});

describe('classifyIntegrationAssetChange', () => {
  it('uses the same unchanged classification for dry-run and live writes', () => {
    expect(
      classifyIntegrationAssetChange({
        exists: true,
        restored: false,
        identityChanged: false,
        fieldsChanged: false,
      }),
    ).toBe('unchanged');
  });

  it('prioritizes restore and otherwise reports update/create', () => {
    expect(classifyIntegrationAssetChange({ exists: true, restored: true, identityChanged: false, fieldsChanged: false })).toBe('restored');
    expect(classifyIntegrationAssetChange({ exists: true, restored: false, identityChanged: true, fieldsChanged: false })).toBe('updated');
    expect(classifyIntegrationAssetChange({ exists: false, restored: false, identityChanged: false, fieldsChanged: false })).toBe('created');
  });
});

describe('AssetsService integration reconstruction helpers', () => {
  function makeIntegrationService(
    prisma: Record<string, unknown>,
    registry: Record<string, unknown> = {},
  ) {
    return new AssetsService(
      prisma as never,
      {} as never,
      registry as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { upsertByName: jest.fn().mockResolvedValue('tag-id') } as never,
    );
  }

  it('uses case-insensitive variants for TEXT match keys', async () => {
    const candidate = {
      id: 'asset-1',
      companyId: 'company-1',
      assetLayoutId: 'layout-1',
      externalSource: 'breeze',
      externalId: 'source-id',
      fieldValues: [],
    };
    const findMany = jest.fn().mockResolvedValue([candidate]);
    const service = makeIntegrationService({
      integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(null) },
      asset: { findFirst: jest.fn().mockResolvedValue(null), findMany },
    });
    const result = await (
      service as unknown as {
        resolveIntegrationAssetTarget: (
          input: Record<string, unknown>,
          layout: Record<string, unknown>,
          values: Record<string, unknown>,
        ) => Promise<{ target: unknown; ambiguous: boolean }>;
      }
    ).resolveIntegrationAssetTarget(
      {
        companyId: 'company-1',
        integrationCompanyMappingId: 'mapping-1',
        resourceId: 'resource-1',
        externalId: 'source-id',
        externalSource: 'breeze',
        assetLayoutId: 'layout-1',
        matchKeyFieldIds: ['field-1'],
      },
      { fields: [{ id: 'field-1', slug: 'hostname', fieldType: 'TEXT' }] },
      { hostname: 'EDGE-01' },
    );

    expect(result).toEqual({ target: candidate, ambiguous: false });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: [
            expect.objectContaining({
              fieldValues: {
                some: expect.objectContaining({
                  OR: expect.arrayContaining([
                    { value: { equals: 'EDGE-01' } },
                    { value: { equals: 'edge-01' } },
                  ]),
                }),
              },
            }),
          ],
        }),
      }),
    );
  });

  it('canonicalizes async field values before persistence checksums are computed', async () => {
    const normalize = jest.fn((value: unknown) => value);
    const preResolve = jest.fn().mockResolvedValue(['tag-id']);
    const service = makeIntegrationService({}, {
      get: jest.fn().mockReturnValue({ preResolve, normalize }),
    });
    const canonical = await (
      service as unknown as {
        canonicalizeFieldValues: (
          tx: unknown,
          layout: Record<string, unknown>,
          values: Record<string, unknown>,
          actorId: string,
          meta: unknown,
        ) => Promise<Record<string, unknown>>;
      }
    ).canonicalizeFieldValues(
      {},
      {
        fields: [
          { id: 'field-tags', slug: 'tags', fieldType: 'TAGS', options: {}, archivedAt: null },
        ],
      },
      { tags: [{ name: 'Production' }] },
      'actor-1',
      { ip: '0.0.0.0', userAgent: 'jest' },
    );

    expect(canonical).toEqual({ tags: ['tag-id'] });
    expect(preResolve).toHaveBeenCalled();
    expect(normalize).toHaveBeenCalledWith(['tag-id'], {});
  });

  it('resolves existing tag names read-only for dry-run classification', async () => {
    const normalize = jest.fn((value: unknown) => value);
    const preResolve = jest.fn();
    const findMany = jest.fn().mockResolvedValue([
      { id: 'tag-id', nameLower: 'production' },
    ]);
    const service = makeIntegrationService(
      { tag: { findMany } },
      { get: jest.fn().mockReturnValue({ preResolve, normalize }) },
    );
    const canonical = await (
      service as unknown as {
        canonicalizeFieldValuesForDryRun: (
          layout: Record<string, unknown>,
          values: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
      }
    ).canonicalizeFieldValuesForDryRun(
      {
        fields: [
          { id: 'field-tags', slug: 'tags', fieldType: 'TAGS', options: {}, archivedAt: null },
        ],
      },
      { tags: [{ name: 'Production' }] },
    );

    expect(canonical).toEqual({ tags: ['tag-id'] });
    expect(findMany).toHaveBeenCalled();
    expect(preResolve).not.toHaveBeenCalled();
  });
});

/**
 * Archive-first purge invariant (WS-015). Permanent deletion must be
 * enforced server-side for both the single-item and bulk paths — the
 * typed-"delete" confirmation dialog in the UI is UX, not a security
 * control. These tests pin:
 *   - purge rejects active assets before the delete transaction runs,
 *   - the delete predicate itself re-asserts `archivedAt != null`
 *     (closes the read→delete race with a concurrent restore),
 *   - purgeMany reports active ids as `not_archived` soft failures.
 */
describe('AssetsService purge (archive-first, WS-015)', () => {
  const actor = { id: 'user-1' } as never;
  const meta = { ip: '127.0.0.1', userAgent: 'jest' } as never;
  const companyId = 'c1';

  function makePurgeService(rows: Record<string, { archivedAt: Date | null }>) {
    const findFirst = jest.fn(({ where }: { where: { id: string } }) => {
      const row = rows[where.id];
      return Promise.resolve(
        row
          ? {
              id: where.id,
              name: `Asset ${where.id}`,
              assetLayoutId: 'layout-1',
              archivedAt: row.archivedAt,
              externalId: null,
              externalSource: null,
            }
          : null,
      );
    });
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    // Post-delete existence probe used only when the guarded delete
    // matched nothing (count 0) to distinguish gone vs restored.
    const txFindFirst = jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(rows[where.id] ? { id: where.id } : null),
    );
    const tx = { asset: { deleteMany, findFirst: txFindFirst } };
    const $transaction = jest.fn(
      async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
    );
    const prisma = { asset: { findFirst }, $transaction };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const relations = { cleanupForAsset: jest.fn().mockResolvedValue(undefined) };
    const searchIndex = { removeAsset: jest.fn().mockResolvedValue(undefined) };
    const service = new AssetsService(
      prisma as never,
      audit as never,
      {} as never,
      relations as never,
      {} as never,
      searchIndex as never,
      {} as never,
      {} as never,
      {} as never,
    );
    return { service, findFirst, deleteMany, txFindFirst, $transaction, audit };
  }

  describe('purge', () => {
    it('deletes an archived asset and re-asserts archivedAt in the delete predicate', async () => {
      const { service, deleteMany, audit } = makePurgeService({
        'a-1': { archivedAt: new Date('2026-01-01') },
      });

      await expect(service.purge(actor, companyId, 'a-1', meta)).resolves.toEqual(
        { id: 'a-1' },
      );

      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(deleteMany.mock.calls[0][0]).toEqual({
        where: { id: 'a-1', companyId, archivedAt: { not: null } },
      });
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'asset.purge', entityId: 'a-1' }),
      );
    });

    it('rejects an active asset before the delete transaction runs', async () => {
      const { service, $transaction, deleteMany } = makePurgeService({
        'a-1': { archivedAt: null },
      });

      await expect(service.purge(actor, companyId, 'a-1', meta)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.purge(actor, companyId, 'a-1', meta)).rejects.toThrow(
        /archive the asset before/i,
      );
      expect($transaction).not.toHaveBeenCalled();
      expect(deleteMany).not.toHaveBeenCalled();
    });

    it('rejects a missing asset with NotFound', async () => {
      const { service } = makePurgeService({});

      await expect(service.purge(actor, companyId, 'ghost', meta)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects with the archive gate when the asset is restored between the read and the delete', async () => {
      // Archived at findFirst time, but the guarded deleteMany matches
      // nothing (count 0) because a concurrent restore cleared archivedAt;
      // the row still exists, so this is `not_archived`, not `not_found`.
      const { service, deleteMany, txFindFirst, audit } = makePurgeService({
        'a-1': { archivedAt: new Date('2026-01-01') },
      });
      deleteMany.mockResolvedValue({ count: 0 });
      txFindFirst.mockResolvedValue({ id: 'a-1' });

      await expect(service.purge(actor, companyId, 'a-1', meta)).rejects.toThrow(
        /archive the asset before/i,
      );
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rejects with NotFound when a concurrent request already purged the row', async () => {
      // Archived at findFirst time, guarded delete matches nothing AND the
      // row is gone — another request won the race. API clients should see
      // 404, not the archive gate.
      const { service, deleteMany, txFindFirst, audit } = makePurgeService({
        'a-1': { archivedAt: new Date('2026-01-01') },
      });
      deleteMany.mockResolvedValue({ count: 0 });
      txFindFirst.mockResolvedValue(null);

      await expect(service.purge(actor, companyId, 'a-1', meta)).rejects.toThrow(
        NotFoundException,
      );
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('purgeMany', () => {
    it('deletes all archived ids', async () => {
      const { service, deleteMany } = makePurgeService({
        'a-1': { archivedAt: new Date('2026-01-01') },
        'a-2': { archivedAt: new Date('2026-01-02') },
      });

      const result = await service.purgeMany(actor, companyId, ['a-1', 'a-2'], meta);

      expect(result).toEqual({ ok: ['a-1', 'a-2'], failed: [] });
      expect(deleteMany).toHaveBeenCalledTimes(2);
    });

    it('reports active ids as not_archived and deletes only the archived ones', async () => {
      const { service, deleteMany } = makePurgeService({
        'a-1': { archivedAt: new Date('2026-01-01') },
        'a-2': { archivedAt: null },
        'a-3': { archivedAt: null },
      });

      const result = await service.purgeMany(
        actor,
        companyId,
        ['a-1', 'a-2', 'a-3'],
        meta,
      );

      expect(result.ok).toEqual(['a-1']);
      expect(result.failed).toEqual([
        {
          id: 'a-2',
          code: 'not_archived',
          reason: 'Archive the asset before permanently deleting it.',
        },
        {
          id: 'a-3',
          code: 'not_archived',
          reason: 'Archive the asset before permanently deleting it.',
        },
      ]);
      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(deleteMany.mock.calls[0][0].where.id).toBe('a-1');
    });

    it('deletes nothing when every id is active', async () => {
      const { service, deleteMany } = makePurgeService({
        'a-1': { archivedAt: null },
        'a-2': { archivedAt: null },
      });

      const result = await service.purgeMany(actor, companyId, ['a-1', 'a-2'], meta);

      expect(result.ok).toEqual([]);
      expect(result.failed.map((f) => f.code)).toEqual([
        'not_archived',
        'not_archived',
      ]);
      expect(deleteMany).not.toHaveBeenCalled();
    });

    it('dedupes repeated ids to one operation each', async () => {
      const { service, deleteMany } = makePurgeService({
        'a-1': { archivedAt: new Date('2026-01-01') },
      });

      const result = await service.purgeMany(
        actor,
        companyId,
        ['a-1', 'a-1', 'a-1'],
        meta,
      );

      expect(result).toEqual({ ok: ['a-1'], failed: [] });
      expect(deleteMany).toHaveBeenCalledTimes(1);
    });
  });
});
