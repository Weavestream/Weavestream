import { AssetsService } from './assets.service.js';

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
