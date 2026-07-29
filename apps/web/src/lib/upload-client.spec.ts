import { UploadError } from '@weavestream/shared/browser';
import { uploadFile } from './upload-client';

/**
 * 5a parity pins, the web mirror of `apps/mobile/src/lib/upload.spec.ts`.
 * The load-bearing difference under test: web's `apiFetch` returns an
 * `{ ok:false, problem:{aborted:true} }` sentinel for an abort instead of
 * throwing, and `uploadFile` must re-classify that as
 * `UploadError('aborted')` — never `init-failed`/`confirm-failed`.
 * Runs in the default node environment; `document` is undefined, so
 * `ensureCsrfTokenForPut` short-circuits and never fetches.
 */

jest.mock('./api', () => ({ apiFetch: jest.fn() }));
jest.mock('@weavestream/shared/browser', () => {
  const actual = jest.requireActual('@weavestream/shared/browser');
  return { ...actual, putWithProgress: jest.fn().mockResolvedValue(undefined) };
});

const { apiFetch } = jest.requireMock('./api') as { apiFetch: jest.Mock };
const { putWithProgress } = jest.requireMock('@weavestream/shared/browser') as {
  putWithProgress: jest.Mock;
};

const COMPANY = 'c0000000-0000-4000-8000-0000000000c1';
const INIT = {
  uploadId: 'a0000000-0000-4000-8000-0000000000a9',
  storageKey: 'k',
  relayUrl: `/api/v1/companies/${COMPANY}/uploads/a0000000-0000-4000-8000-0000000000a9/blob`,
  expiresAt: '2026-07-28T00:15:00.000Z',
};
const CONFIRM = { id: INIT.uploadId, filename: 'rack.jpg' };

const ok = (data: unknown) => ({ ok: true, status: 200, data });
const fail = (problem: unknown, status = 400) => ({ ok: false, status, data: null, problem });
const abortedSentinel = () => ({ ok: false, status: 0, data: null, problem: { aborted: true } });

function jpgFile(): File {
  return new File([new Uint8Array(8)], 'rack.jpg', { type: 'image/jpeg' });
}

beforeEach(() => {
  jest.clearAllMocks();
  putWithProgress.mockResolvedValue(undefined);
});

describe('uploadFile', () => {
  it('runs init → PUT → confirm with the signal on every step and no attachedToId', async () => {
    apiFetch.mockResolvedValueOnce(ok(INIT)).mockResolvedValueOnce(ok(CONFIRM));

    const ctrl = new AbortController();
    const res = await uploadFile({
      companyId: COMPANY,
      file: jpgFile(),
      attachTo: { type: 'asset' },
      signal: ctrl.signal,
    });

    expect(res).toEqual(CONFIRM);
    expect(apiFetch.mock.calls[0]![0]).toBe(`/companies/${COMPANY}/uploads/init`);
    const initBody = JSON.parse(apiFetch.mock.calls[0]![1].body as string);
    expect(initBody).toEqual({
      filename: 'rack.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 8,
      attachedToType: 'asset',
      // attachedToId ABSENT — FILE-field uploads never pass an id
      // (create or edit); linkFileFieldUploadsToAsset attaches inside
      // the asset-write transaction.
    });
    expect(initBody).not.toHaveProperty('attachedToId');

    expect(apiFetch.mock.calls[1]![0]).toBe(`/companies/${COMPANY}/uploads/confirm`);
    const confirmBody = JSON.parse(apiFetch.mock.calls[1]![1].body as string);
    expect(confirmBody).toEqual({ uploadId: INIT.uploadId, attachedToType: 'asset' });
    expect(confirmBody).not.toHaveProperty('attachedToId');

    // The abort signal covers ALL THREE steps — a Cancel during init or
    // confirm must actually stop the upload, not just the relay PUT.
    expect(apiFetch.mock.calls[0]![1].signal).toBe(ctrl.signal);
    expect(apiFetch.mock.calls[1]![1].signal).toBe(ctrl.signal);
    expect(putWithProgress).toHaveBeenCalledWith(
      INIT.relayUrl,
      expect.any(File),
      expect.objectContaining({ signal: ctrl.signal }),
    );
  });

  it('classifies an abort during init as UploadError("aborted"), not init-failed', async () => {
    apiFetch.mockResolvedValueOnce(abortedSentinel());
    const err = await uploadFile({ companyId: COMPANY, file: jpgFile() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('aborted');
    expect(putWithProgress).not.toHaveBeenCalled();
  });

  it('classifies an abort during confirm as UploadError("aborted"), not confirm-failed', async () => {
    apiFetch.mockResolvedValueOnce(ok(INIT)).mockResolvedValueOnce(abortedSentinel());
    const err = await uploadFile({ companyId: COMPANY, file: jpgFile() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('aborted');
    expect(putWithProgress).toHaveBeenCalledTimes(1);
  });

  it('wraps a real init failure as UploadError("init-failed") carrying the problem', async () => {
    apiFetch.mockResolvedValueOnce(fail({ error: 'MimeNotAllowed', mimeType: 'video/mp4' }, 415));
    const err = await uploadFile({ companyId: COMPANY, file: jpgFile() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('init-failed');
    expect((err as UploadError).detail).toEqual({
      error: 'MimeNotAllowed',
      mimeType: 'video/mp4',
    });
    expect(putWithProgress).not.toHaveBeenCalled();
  });

  it('wraps a real confirm failure as UploadError("confirm-failed")', async () => {
    apiFetch.mockResolvedValueOnce(ok(INIT)).mockResolvedValueOnce(fail({ error: 'MimeMismatch' }));
    const err = await uploadFile({ companyId: COMPANY, file: jpgFile() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('confirm-failed');
  });

  it('lets putWithProgress UploadErrors (incl. aborted) pass through untouched', async () => {
    apiFetch.mockResolvedValueOnce(ok(INIT));
    putWithProgress.mockRejectedValueOnce(new UploadError('aborted'));
    const err = await uploadFile({ companyId: COMPANY, file: jpgFile() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('aborted');
    // Confirm never ran.
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
