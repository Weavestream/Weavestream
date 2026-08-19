'use client';

import {
  UploadError,
  inferMime,
  putWithProgress,
  type ConfirmUploadResponse,
  type InitUploadResponse,
  type UploadProgress,
} from '@weavestream/shared/browser';
import type { UploadAttachmentType } from '@weavestream/shared';
import { apiFetch } from './api';

/**
 * Web-side orchestration of the 3-step upload protocol
 * (init → PUT → confirm). `apiFetch` handles the JSON init/confirm
 * calls (cookie + CSRF); the PUT is sent over the same origin to a
 * relay endpoint on the API, which streams the body into local
 * filesystem storage — so the browser never needs to reach the storage
 * layer directly.
 *
 * Phase 2c: the framework-free pieces (preflight, mime inference, the
 * progress PUT, error prose) moved to
 * `@weavestream/shared/browser/upload-client` so `apps/mobile` shares
 * them. This module keeps only the web `apiFetch` orchestration and
 * re-exports the moved names so existing import sites are unchanged —
 * new code may import them from `@weavestream/shared/browser` directly.
 */

export { describeUploadError, preflightFile } from '@weavestream/shared/browser';
export type {
  ConfirmUploadResponse,
  UploadProgress,
} from '@weavestream/shared/browser';
export type { UploadAttachmentType } from '@weavestream/shared';

export async function uploadFile(opts: {
  companyId: string;
  file: File;
  attachTo?: { type: UploadAttachmentType; id?: string };
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}): Promise<ConfirmUploadResponse> {
  const { companyId, file } = opts;

  const initRes = await apiFetch<InitUploadResponse>(
    `/companies/${companyId}/uploads/init`,
    {
      method: 'POST',
      // The signal covers ALL THREE steps, not just the relay PUT — a
      // Cancel during init or confirm must actually stop the upload
      // rather than silently committing it after the user dismissed it.
      signal: opts.signal,
      body: JSON.stringify({
        filename: file.name,
        // Use the same extension-aware inference as `preflightFile` so the
        // declared type the server validates matches what the preflight
        // approved. Browsers leave `File.type` empty for extensions they
        // don't recognise (e.g. `.ps1`), which would otherwise reach the
        // server as `application/octet-stream` and fail the confirm step's
        // magic-bytes/text gate. `inferMime` returns the browser type
        // unchanged whenever it's present, so known types are unaffected.
        mimeType: inferMime(file),
        sizeBytes: file.size,
        attachedToType: opts.attachTo?.type,
        attachedToId: opts.attachTo?.id,
      }),
    },
  );
  if (!initRes.ok || !initRes.data) {
    throw toUploadError(initRes.problem, 'init-failed');
  }
  const init = initRes.data;

  await putWithProgress(init.relayUrl, file, {
    onProgress: opts.onProgress,
    signal: opts.signal,
    csrfToken: await ensureCsrfTokenForPut(opts.signal),
  });

  const confirmRes = await apiFetch<ConfirmUploadResponse>(
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
  if (!confirmRes.ok || !confirmRes.data) {
    throw toUploadError(confirmRes.problem, 'confirm-failed');
  }
  return confirmRes.data;
}

/**
 * This app's `apiFetch` folds an aborted request into a
 * `{ problem: { aborted: true } }` envelope instead of throwing (mobile's
 * client rethrows the platform AbortError). Re-classify that envelope as
 * `UploadError('aborted')` — the same kind `putWithProgress` produces —
 * so a deliberate Cancel is never reported as `init-failed`/`confirm-failed`.
 */
function toUploadError(
  problem: unknown,
  code: 'init-failed' | 'confirm-failed',
): UploadError {
  const aborted =
    typeof problem === 'object' &&
    problem !== null &&
    (problem as { aborted?: unknown }).aborted === true;
  return aborted ? new UploadError('aborted') : new UploadError(code, problem);
}

/**
 * Cookie-based CSRF for same-origin requests. Mirrors the read in
 * `apiFetch`: prefer the cookie set by an earlier non-GET call, and
 * mint a fresh token via the `/auth/csrf` endpoint if none exists yet.
 * (Near-duplicate of shared `ensureCsrf`, which throws on mint failure
 * where this proceeds token-less — kept as-is deliberately; flagged as
 * a later cleanup, not changed in Phase 2c.)
 */
async function ensureCsrfTokenForPut(
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (typeof document === 'undefined') return undefined;
  const fromCookie = readCookie('ws_csrf');
  if (fromCookie) return fromCookie;
  const res = await fetch('/api/v1/auth/csrf', {
    method: 'POST',
    credentials: 'include',
    signal,
  });
  if (!res.ok) return undefined;
  const data = (await res.json().catch(() => null)) as { csrfToken?: string } | null;
  return data?.csrfToken ?? undefined;
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]!) : undefined;
}
