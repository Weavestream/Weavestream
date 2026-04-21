'use client';

import { apiFetch } from './api';

/**
 * Client-side helper for the 3-step upload protocol (init → PUT → confirm).
 * Lives on the browser, so it goes through `apiFetch` (which handles CSRF)
 * for the two API calls and a plain `XMLHttpRequest` PUT for progress
 * reporting against MinIO.
 *
 * The MinIO public URL lives at `MINIO_PUBLIC_URL` on the server and is
 * returned as `presignedUrl` in the init response, so browsers never need
 * to know about the internal Docker network hostname.
 */

export type InitUploadResponse = {
  uploadId: string;
  storageKey: string;
  presignedUrl: string;
  expiresAt: string;
};

export type ConfirmUploadResponse = {
  id: string;
  companyId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
  createdAt: string;
};

export type UploadProgress = {
  loaded: number;
  total: number;
  percent: number;
};

export type UploadAttachmentType = 'asset' | 'article' | 'asset_field';

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
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        attachedToType: opts.attachTo?.type,
        attachedToId: opts.attachTo?.id,
      }),
    },
  );
  if (!initRes.ok || !initRes.data) {
    throw new UploadError('init-failed', initRes.problem);
  }
  const init = initRes.data;

  await putWithProgress(init.presignedUrl, file, opts.onProgress, opts.signal);

  const confirmRes = await apiFetch<ConfirmUploadResponse>(
    `/companies/${companyId}/uploads/confirm`,
    {
      method: 'POST',
      body: JSON.stringify({
        uploadId: init.uploadId,
        attachedToType: opts.attachTo?.type,
        attachedToId: opts.attachTo?.id,
      }),
    },
  );
  if (!confirmRes.ok || !confirmRes.data) {
    throw new UploadError('confirm-failed', confirmRes.problem);
  }
  return confirmRes.data;
}

function putWithProgress(
  url: string,
  file: File,
  onProgress?: (p: UploadProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    if (onProgress) {
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return;
        onProgress({
          loaded: ev.loaded,
          total: ev.total,
          percent: ev.total > 0 ? Math.round((ev.loaded / ev.total) * 100) : 0,
        });
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new UploadError('put-failed', { status: xhr.status }));
    };
    xhr.onerror = () => reject(new UploadError('network-error'));
    xhr.onabort = () => reject(new UploadError('aborted'));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

export class UploadError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: unknown,
  ) {
    super(code);
    this.name = 'UploadError';
  }
}

/**
 * User-facing, non-technical bucket of file kinds we accept. Kept in
 * sync by hand with `ALLOWED_UPLOAD_MIME` in `packages/shared/src/env.ts`.
 * We intentionally summarise instead of dumping mime strings at the user.
 */
export const SUPPORTED_FILE_KINDS =
  'images (JPG, PNG, WebP, GIF, HEIC), PDFs, Word, Excel, Markdown, CSV, plain text, archives (ZIP, 7Z, TAR, GZ), installers (MSI), Outlook messages (MSG), scripts (PS1, CMD, BAT, SH, REG, PY), or config files (JSON, XML, YAML, INI, CONF, LOG)';

/**
 * Optimistic client-side allowlist used for pre-flight validation. It
 * intentionally *mirrors* the server allowlist rather than being the
 * source of truth — the server still has final say on accept/reject,
 * but checking here lets us reject obviously-invalid drops before the
 * spinner ever starts.
 */
const CLIENT_ALLOWED_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-7z-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-msi',
  'application/x-ms-installer',
  'application/vnd.ms-outlook',
  'text/x-shellscript',
  'text/x-python',
  'application/json',
  'application/xml',
  'text/xml',
  'text/yaml',
  'application/x-yaml',
]);

/**
 * Extension fallback for browsers/OSes that don't stamp a recognisable
 * `File.type` (notably common for `.md` and `.csv` on some Linux + old
 * Windows configurations). Keyed by lowercased extension without dot.
 */
const EXT_TO_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Archives
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  // Microsoft installers + Outlook messages
  msi: 'application/x-msi',
  msg: 'application/vnd.ms-outlook',
  // Scripts (no magic bytes; server's text/* fallback lets these through)
  ps1: 'text/plain',
  psm1: 'text/plain',
  cmd: 'text/plain',
  bat: 'text/plain',
  reg: 'text/plain',
  sh: 'text/x-shellscript',
  py: 'text/x-python',
  // Structured config / log files
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  ini: 'text/plain',
  conf: 'text/plain',
  log: 'text/plain',
};

/** Best-effort MIME inference — browser-declared type wins, ext is fallback. */
function inferMime(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const dot = file.name.lastIndexOf('.');
  if (dot === -1) return file.type || 'application/octet-stream';
  const ext = file.name.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] ?? file.type ?? 'application/octet-stream';
}

export type UploadPreflightLimits = {
  /** Max allowed size in bytes. Pass `null`/omit to skip the size check. */
  maxBytes?: number | null;
};

/**
 * Client-side pre-flight: cheap checks that produce a nice error
 * message *before* we bother the server. Returns `null` when the file
 * looks uploadable, or a user-facing sentence describing the problem.
 */
export function preflightFile(
  file: File,
  limits: UploadPreflightLimits = {},
): string | null {
  if (limits.maxBytes != null && file.size > limits.maxBytes) {
    return `“${file.name}” is ${humanSize(file.size)}, which exceeds the ${humanSize(
      limits.maxBytes,
    )} per-file limit.`;
  }
  const mime = inferMime(file).toLowerCase();
  if (!CLIENT_ALLOWED_MIMES.has(mime)) {
    return `“${file.name}” isn't a supported file type${
      mime && mime !== 'application/octet-stream' ? ` (${mime})` : ''
    }. Supported: ${SUPPORTED_FILE_KINDS}.`;
  }
  return null;
}

type ProblemShape = {
  error?: unknown;
  message?: unknown;
  detail?: unknown;
  mimeType?: unknown;
  maxBytes?: unknown;
  sizeBytes?: unknown;
  declared?: unknown;
  detected?: unknown;
};

function asProblem(value: unknown): ProblemShape | null {
  if (value && typeof value === 'object') return value as ProblemShape;
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Translate anything thrown by `uploadFile` into a single, non-technical
 * sentence suitable for a toast or inline error panel. Covers:
 *   - `UploadError` with an RFC 7807 problem body (the common case)
 *   - plain `Error` (rare — network/abort paths)
 *   - anything else (`unknown`) as a safe fallback
 */
export function describeUploadError(
  err: unknown,
  filename?: string,
  /**
   * Tenant term singular (lowercase) — admins can rename "company" to
   * "client" / "department" / etc., and the rare CompanyScopeMismatch
   * error needs to reflect that. Defaults to 'company' so callers that
   * don't have a term context (tests, legacy code) still read sensibly.
   */
  tenantTerm = 'company',
): string {
  const who = filename ? `“${filename}”` : 'This file';
  if (err instanceof UploadError) {
    const problem = asProblem(err.detail);
    const serverCode = str(problem?.error);
    const serverMsg = str(problem?.message);

    switch (serverCode) {
      case 'MimeNotAllowed': {
        const mime = str(problem?.mimeType);
        return `${who} isn't a supported file type${
          mime ? ` (${mime})` : ''
        }. Supported: ${SUPPORTED_FILE_KINDS}.`;
      }
      case 'FileTooLarge': {
        const maxBytes = num(problem?.maxBytes);
        const sizeBytes = num(problem?.sizeBytes);
        const sizeStr = sizeBytes != null ? ` (${humanSize(sizeBytes)})` : '';
        const maxStr = maxBytes != null ? humanSize(maxBytes) : 'the per-file limit';
        return `${who}${sizeStr} is larger than ${maxStr}.`;
      }
      case 'MimeMismatch': {
        const declared = str(problem?.declared);
        const detected = str(problem?.detected);
        return `${who}'s contents don't match its extension${
          declared && detected ? ` (declared ${declared}, looks like ${detected})` : ''
        }. The file may be corrupt or mis-typed.`;
      }
      case 'MimeUndetectable':
        return `We couldn't verify ${who}'s contents. Try re-saving or exporting it, then upload again.`;
      case 'PendingUploadNotFound':
      case 'UploadNotFound':
        return `The upload session for ${who} expired. Please try again.`;
      case 'CompanyScopeMismatch':
        return `${who} couldn't be attached to this ${tenantTerm}. Please reload and try again.`;
      default:
        break;
    }

    switch (err.code) {
      case 'network-error':
        return `Upload of ${who} was interrupted. Check your connection and try again.`;
      case 'aborted':
        return `Upload of ${who} was cancelled.`;
      case 'put-failed':
        return `${who} couldn't be uploaded to storage. Please try again.`;
      case 'init-failed':
        return serverMsg
          ? `${who} couldn't be uploaded — ${serverMsg}`
          : `${who} couldn't be uploaded. Please try again.`;
      case 'confirm-failed':
        return serverMsg
          ? `${who} was uploaded but couldn't be saved — ${serverMsg}`
          : `${who} was uploaded but couldn't be saved. Please try again.`;
      default:
        return serverMsg ?? `Upload of ${who} failed. Please try again.`;
    }
  }

  if (err instanceof Error && err.message) {
    return `Upload of ${who} failed — ${err.message}.`;
  }
  return `Upload of ${who} failed. Please try again.`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
