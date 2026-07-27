import { UploadError } from '@weavestream/shared/browser';
import { ApiError } from './api';
import { uploadFile } from './upload';

jest.mock('./api', () => {
  const actual = jest.requireActual('./api');
  return { ...actual, apiFetch: jest.fn() };
});
jest.mock('@weavestream/shared/browser', () => {
  const actual = jest.requireActual('@weavestream/shared/browser');
  return {
    ...actual,
    putWithProgress: jest.fn().mockResolvedValue(undefined),
    ensureCsrf: jest.fn().mockResolvedValue('csrf-token'),
  };
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
  expiresAt: '2026-07-26T00:15:00.000Z',
};
const CONFIRM = { id: INIT.uploadId, filename: 'rack.jpg' };

function pngFile(): File {
  return new File([new Uint8Array(8)], 'rack.jpg', { type: 'image/jpeg' });
}

beforeEach(() => {
  jest.clearAllMocks();
  putWithProgress.mockResolvedValue(undefined);
});

describe('uploadFile', () => {
  it('runs init → PUT (with CSRF) → confirm and returns the confirm payload', async () => {
    apiFetch
      .mockResolvedValueOnce(INIT)
      .mockResolvedValueOnce(CONFIRM);

    const ctrl = new AbortController();
    const res = await uploadFile({
      companyId: COMPANY,
      file: pngFile(),
      attachTo: { type: 'asset' },
      signal: ctrl.signal,
    });

    expect(res).toEqual(CONFIRM);
    const initBody = JSON.parse(apiFetch.mock.calls[0]![1].body as string);
    expect(apiFetch.mock.calls[0]![0]).toBe(`/companies/${COMPANY}/uploads/init`);
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

    expect(putWithProgress).toHaveBeenCalledWith(
      INIT.relayUrl,
      expect.any(File),
      expect.objectContaining({ csrfToken: 'csrf-token' }),
    );

    const confirmBody = JSON.parse(apiFetch.mock.calls[1]![1].body as string);
    expect(apiFetch.mock.calls[1]![0]).toBe(`/companies/${COMPANY}/uploads/confirm`);
    expect(confirmBody).toEqual({ uploadId: INIT.uploadId, attachedToType: 'asset' });
    expect(confirmBody).not.toHaveProperty('attachedToId');

    // The abort signal covers ALL THREE steps — a Cancel during init or
    // confirm must actually stop the upload, not just the relay PUT.
    expect(apiFetch.mock.calls[0]![1].signal).toBe(ctrl.signal);
    expect(apiFetch.mock.calls[1]![1].signal).toBe(ctrl.signal);
  });

  it('wraps init ApiErrors as UploadError("init-failed") carrying the problem', async () => {
    apiFetch.mockRejectedValueOnce(
      new ApiError(415, { error: 'MimeNotAllowed', mimeType: 'video/mp4' }),
    );
    const err = await uploadFile({ companyId: COMPANY, file: pngFile() }).catch(
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

  it('wraps confirm ApiErrors as UploadError("confirm-failed")', async () => {
    apiFetch
      .mockResolvedValueOnce(INIT)
      .mockRejectedValueOnce(new ApiError(400, { error: 'MimeMismatch' }));
    const err = await uploadFile({ companyId: COMPANY, file: pngFile() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('confirm-failed');
  });

  it('lets putWithProgress UploadErrors (incl. aborted) pass through untouched', async () => {
    apiFetch.mockResolvedValueOnce(INIT);
    putWithProgress.mockRejectedValueOnce(new UploadError('aborted'));
    const err = await uploadFile({ companyId: COMPANY, file: pngFile() }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).code).toBe('aborted');
    // Confirm never ran.
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
