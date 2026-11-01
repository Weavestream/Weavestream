import type { BulkAssetResult } from '@weavestream/shared';
import { runInBatches, type BulkBatchResponse } from './bulk-batches';

const ids = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => `id-${from + i}`);

/** A 200 response where every id in the batch succeeded. */
const allOk = async (batch: string[]): Promise<BulkBatchResponse> => ({
  ok: true,
  data: { ok: batch, failed: [] },
});

describe('runInBatches', () => {
  it('splits 1,200 ids into 500 / 500 / 200, in order, and merges the results', async () => {
    const all = ids(1200);
    const send = jest.fn(allOk);

    const out = await runInBatches(all, 500, send);

    expect(send.mock.calls.map(([b]) => b.length)).toEqual([500, 500, 200]);
    expect(send.mock.calls.map(([b]) => b[0])).toEqual(['id-1', 'id-501', 'id-1001']);
    expect(out.ok).toEqual(all);
    expect(out.failed).toEqual([]);
    expect(out.stopped).toBeNull();
    expect(out.remaining).toEqual([]);
  });

  it('sends 501 ids as 500 + 1', async () => {
    const send = jest.fn(allOk);
    await runInBatches(ids(501), 500, send);
    expect(send.mock.calls.map(([b]) => b.length)).toEqual([500, 1]);
  });

  it('merges mixed per-item results and keeps only the failed ids selected', async () => {
    const send = jest.fn(async (batch: string[]): Promise<BulkBatchResponse> => {
      const [first, ...rest] = batch;
      const data: BulkAssetResult = {
        ok: rest,
        failed: [{ id: first!, reason: 'Already archived.', code: 'already_archived' }],
      };
      return { ok: true, data };
    });

    const out = await runInBatches(ids(4), 2, send);

    expect(out.ok).toEqual(['id-2', 'id-4']);
    expect(out.failed.map((f) => f.id)).toEqual(['id-1', 'id-3']);
    expect(out.stopped).toBeNull();
    expect(out.remaining).toEqual(['id-1', 'id-3']);
  });

  it('keeps the batch that failed selected when a later request is rejected (regression)', async () => {
    const problem = { title: 'Too Many Requests', status: 429 };
    const send = jest
      .fn<Promise<BulkBatchResponse>, [string[]]>()
      .mockImplementationOnce(allOk)
      .mockResolvedValueOnce({ ok: false, data: null, problem });

    const out = await runInBatches(ids(1200), 500, send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(out.stopped).toEqual({ problem, thrown: false });
    expect(out.ok).toEqual(ids(500));
    // 501–1,200: the batch that failed plus the batch never sent.
    expect(out.remaining).toEqual(ids(700, 501));
  });

  it('treats a thrown network error like a failed response and resolves', async () => {
    const err = new TypeError('Failed to fetch');
    const send = jest
      .fn<Promise<BulkBatchResponse>, [string[]]>()
      .mockImplementationOnce(allOk)
      .mockRejectedValueOnce(err);

    const out = await runInBatches(ids(1200), 500, send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(out.stopped).toEqual({ problem: err, thrown: true });
    expect(out.ok).toEqual(ids(500));
    expect(out.remaining).toEqual(ids(700, 501));
  });

  it('keeps earlier per-item failures and the unsent ids after a thrown error', async () => {
    const send = jest
      .fn<Promise<BulkBatchResponse>, [string[]]>()
      .mockImplementationOnce(async (batch) => ({
        ok: true,
        data: {
          ok: batch.slice(2),
          failed: batch.slice(0, 2).map((id) => ({ id, reason: 'Permission denied.', code: 'forbidden' })),
        },
      }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const out = await runInBatches(ids(1200), 500, send);

    expect(out.ok).toEqual(ids(498, 3));
    expect(out.remaining).toEqual(['id-1', 'id-2', ...ids(700, 501)]);
  });

  it('rejects an invalid batch size instead of sending nothing or looping', async () => {
    const send = jest.fn(allOk);
    await expect(runInBatches(ids(3), 0, send)).rejects.toThrow(RangeError);
    await expect(runInBatches(ids(3), Number.NaN, send)).rejects.toThrow(RangeError);
    expect(send).not.toHaveBeenCalled();
  });
});
