import {
  UploadError,
  ensureCsrf,
  inferMime,
  putWithProgress,
  type ConfirmUploadResponse,
  type InitUploadResponse,
  type UploadProgress,
} from '@weavestream/shared/browser';
import type { UploadAttachmentType } from '@weavestream/shared';
import { ApiError, apiFetch } from './api';

/**
 * Mobile orchestration of the 3-step upload protocol
 * (init → PUT → confirm), on this app's throwing `apiFetch` contract.
 * The framework-free pieces (mime inference, the progress PUT, error
 * prose) live in `@weavestream/shared/browser`; `apps/web` keeps its
 * own thin orchestration on its `{ok, data, problem}` contract.
 *
 * `ApiError`s from init/confirm are rethrown as `UploadError` carrying
 * the RFC 7807 problem, so shared `describeUploadError` renders the
 * same sentences on both apps. Uploads never demand step-up, and both
 * JSON bodies are strings, so `apiFetch`'s replay guard is moot here.
 *
 * FILE-FIELD CALLERS NEVER PASS `attachTo.id` — on create OR edit.
 * Confirming with an asset id attaches the upload durably right there,
 * so a cancelled/failed form would leave a ghost attachment on the
 * asset. With only the type, `linkFileFieldUploadsToAsset` associates
 * the upload inside the successful asset-write transaction instead
 * (both create and update call it). Lives in `lib/` because the
 * articles phase is expected to reuse it.
 */
export async function uploadFile(opts: {
  companyId: string;
  file: File;
  attachTo?: { type: UploadAttachmentType; id?: string };
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<ConfirmUploadResponse> {
  const { companyId, file } = opts;

  let init: InitUploadResponse;
  try {
    init = await apiFetch<InitUploadResponse>(
      `/companies/${companyId}/uploads/init`,
      {
        method: 'POST',
        // The signal covers ALL THREE steps, not just the relay PUT —
        // a Cancel during init or confirm must actually stop the
        // upload rather than silently committing it after the user
        // dismissed it. (A confirm the server already processed when
        // the abort lands is an unreferenced upload — the flagged
        // orphan-sweep follow-up's territory, same as abandoned forms.)
        signal: opts.signal,
        body: JSON.stringify({
          filename: file.name,
          // Same extension-aware inference the preflight used, so the
          // declared type the server validates matches what was approved.
          mimeType: inferMime(file),
          sizeBytes: file.size,
          attachedToType: opts.attachTo?.type,
          attachedToId: opts.attachTo?.id,
        }),
      },
    );
  } catch (err) {
    throw wrap(err, 'init-failed');
  }

  await putWithProgress(init.relayUrl, file, {
    onProgress: opts.onProgress,
    signal: opts.signal,
    csrfToken: await ensureCsrf(),
  });

  try {
    return await apiFetch<ConfirmUploadResponse>(
      `/companies/${companyId}/uploads/confirm`,
      {
        method: 'POST',
        signal: opts.signal,
        body: JSON.stringify({
          uploadId: init.uploadId,
          attachedToType: opts.attachTo?.type,
          attachedToId: opts.attachTo?.id,
        }),
      },
    );
  } catch (err) {
    throw wrap(err, 'confirm-failed');
  }
}

function wrap(err: unknown, code: 'init-failed' | 'confirm-failed'): unknown {
  if (err instanceof ApiError) return new UploadError(code, err.problem);
  // Aborted fetches and UploadErrors (from putWithProgress) pass through.
  return err;
}
