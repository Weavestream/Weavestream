/** @jest-environment jsdom */
import { copySecret } from './copy';
import { copyToClipboard, copyWithPromise } from '@weavestream/shared/browser';
import { scheduleClipboardClear } from './clipboard-guard';

jest.mock('@weavestream/shared/browser', () => ({
  copyToClipboard: jest.fn(),
  copyWithPromise: jest.fn(),
}));
jest.mock('./clipboard-guard', () => ({
  scheduleClipboardClear: jest.fn(),
}));

const copyToClipboardMock = copyToClipboard as jest.MockedFunction<typeof copyToClipboard>;
const copyWithPromiseMock = copyWithPromise as jest.MockedFunction<typeof copyWithPromise>;

beforeEach(() => jest.clearAllMocks());

describe('copySecret', () => {
  it('invokes copyWithPromise SYNCHRONOUSLY — the user-gesture token dies at the first await', () => {
    copyWithPromiseMock.mockResolvedValue(true);
    void copySecret({ fetch: () => Promise.resolve('s3cret') });
    // Same tick, before any microtask has run: the call must already
    // have happened, otherwise Safari has discarded the gesture.
    expect(copyWithPromiseMock).toHaveBeenCalledTimes(1);
  });

  it('runs the reveal exactly once even when the helper invokes the provider twice', async () => {
    // Real copyWithPromise calls provider() for the ClipboardItem path
    // and AGAIN for the writeText fallback — simulate that worst case.
    copyWithPromiseMock.mockImplementation(async (provider) => {
      await provider();
      await provider();
      return true;
    });
    const fetch = jest.fn().mockResolvedValue('s3cret');

    const result = await copySecret({ fetch });
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1); // one audit row, one throttle unit
    expect(scheduleClipboardClear).toHaveBeenCalledTimes(1);
  });

  it('surfaces the reveal error the helper swallowed — once, not twice', async () => {
    copyWithPromiseMock.mockImplementation(async (provider) => {
      // The helper swallows provider rejections on both paths and
      // reports plain `false`.
      await provider().catch(() => {});
      await provider().catch(() => {});
      return false;
    });
    const sentinel = new Error('ReasonRequired');
    const fetch = jest.fn().mockRejectedValue(sentinel);

    const result = await copySecret({ fetch });
    expect(result).toEqual({ ok: false, error: sentinel });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(scheduleClipboardClear).not.toHaveBeenCalled();
  });

  it('copies a cached value directly without touching the reveal path', async () => {
    copyToClipboardMock.mockResolvedValue(true);
    const fetch = jest.fn();

    const result = await copySecret({ cached: 'already-revealed', fetch });
    expect(result).toEqual({ ok: true });
    expect(copyToClipboardMock).toHaveBeenCalledWith('already-revealed');
    expect(copyWithPromiseMock).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(scheduleClipboardClear).toHaveBeenCalledTimes(1);
  });

  it('reports a plain clipboard failure with error:null (nothing to classify)', async () => {
    copyToClipboardMock.mockResolvedValue(false);
    const result = await copySecret({ cached: 'value' });
    expect(result).toEqual({ ok: false, error: null });
    expect(scheduleClipboardClear).not.toHaveBeenCalled();
  });
});
