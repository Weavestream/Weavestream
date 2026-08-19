'use client';

import { useEffect, useRef, useState } from 'react';
import { FILE_MULTI_CAP } from '@weavestream/shared';
import { matchesAccept } from '@weavestream/shared/browser';
import { humanSize } from '@weavestream/shared';
import { Icon, Tag } from '../ui';
import {
  describeUploadError,
  preflightFile,
  uploadFile,
  type ConfirmUploadResponse,
  type UploadAttachmentType,
} from '../../lib/upload-client';

/**
 * Dropzone used by `FILE` fields on assets. The caller owns persistence
 * (i.e. writes the list back into the field value); this component owns
 * the upload lifecycle, mirroring mobile's `FileFieldEditor` (the
 * server-aligned 5a reference): absent `multiple` means SINGLE, a
 * single-mode pick keeps the first file and supersedes (aborts) any
 * still-running upload, commits go through a render-synced ref so
 * overlapping confirms never clobber each other, and failures keep
 * their row with Retry/Dismiss instead of toasting. Pick-time
 * rejections (accept / size / the 100-file cap) surface in the inline
 * alert list — `matchesAccept` runs on every file because the HTML
 * `accept` attribute is only a picker hint and drops bypass it.
 */
export type FileFieldEntry = {
  uploadId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage?: boolean;
  thumbnailUrl?: string | null;
  downloadUrl?: string | null;
};

interface PendingUpload {
  key: string;
  file: File;
  percent: number;
  controller: AbortController;
  /** Non-null = failed (retry/dismiss); null = uploading. */
  error: string | null;
}

export function FileDropzone({
  companyId,
  value,
  onChange,
  attachTo,
  disabled,
  multiple = false,
  accept,
  maxSizeMb,
  onPendingChange,
}: {
  companyId: string;
  value: FileFieldEntry[];
  onChange: (next: FileFieldEntry[]) => void;
  attachTo?: { type: UploadAttachmentType; id?: string };
  disabled?: boolean;
  multiple?: boolean;
  accept?: string[];
  maxSizeMb?: number;
  onPendingChange?: (inFlight: number) => void;
}) {
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const counter = useRef(0);

  // The committed array lives in the parent's form state, which async
  // confirms close over. This ref tracks the LATEST committed value:
  // every internal mutation (confirm, removal) writes it synchronously
  // before calling onChange — two confirms landing in the same tick
  // each see the other's append instead of a stale snapshot (React
  // hasn't re-rendered between their microtasks). The effect only
  // reconciles EXTERNAL value changes back in.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  // Every in-flight upload's abort controller, so single-file mode can
  // supersede older uploads the moment a new pick starts.
  const inFlightControllers = useRef(new Set<AbortController>());

  // Identity guard: parents may pass an inline per-slug wrapper. The
  // sync effect runs every commit (declared before the emit effect so a
  // changed callback is current when the count fires); the emit/cleanup
  // effects depend only on the count / mount, never on the callback
  // identity, or every parent render would fire the cleanup and report
  // a transient 0.
  const onPendingChangeRef = useRef(onPendingChange);
  useEffect(() => {
    onPendingChangeRef.current = onPendingChange;
  });
  const inFlight = pending.filter((p) => p.error === null).length;
  useEffect(() => {
    onPendingChangeRef.current?.(inFlight);
  }, [inFlight]);
  // Unmount must release the parent's Save gate.
  useEffect(() => () => onPendingChangeRef.current?.(0), []);

  // Per-field cap ?? the shared schema default (25). The env-wide
  // NEXT_PUBLIC_MAX_UPLOAD_MB is deliberately not consulted here —
  // mobile reads only the field option, and the server still enforces
  // its own limit at the relay.
  const maxBytes = (maxSizeMb ?? 25) * 1024 * 1024;

  function startUpload(file: File) {
    // `disabled` also gates Retry: once Save is in flight the payload is
    // captured, so a retried upload could confirm after navigation and
    // become an unattached orphan that looks saved.
    if (disabled) return;

    // Single-file mode: a new pick SUPERSEDES anything still uploading.
    // Without this, a slower earlier upload that finishes last would
    // overwrite the newer selection (its confirm replaces the array).
    // Aborting first means at most one upload can ever commit.
    if (!multiple) {
      for (const controller of inFlightControllers.current) controller.abort();
    }

    const key = `${file.name}:${file.size}:${counter.current++}`;
    const controller = new AbortController();
    inFlightControllers.current.add(controller);
    setPending((prev) => [
      ...prev,
      { key, file, percent: 0, controller, error: null },
    ]);

    uploadFile({
      companyId,
      file,
      attachTo,
      signal: controller.signal,
      onProgress: (p) =>
        setPending((prev) =>
          prev.map((entry) =>
            entry.key === key ? { ...entry, percent: p.percent } : entry,
          ),
        ),
    })
      .then((resp) => {
        // Commit through the synchronous ref, not the render-time prop.
        const next = multiple
          ? [...valueRef.current, toEntry(resp)]
          : [toEntry(resp)];
        valueRef.current = next;
        onChange(next);
        setPending((prev) => prev.filter((entry) => entry.key !== key));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) {
          // Cancelled or superseded — remove silently.
          setPending((prev) => prev.filter((entry) => entry.key !== key));
          return;
        }
        setPending((prev) =>
          prev.map((entry) =>
            entry.key === key
              ? { ...entry, error: describeUploadError(err, file.name) }
              : entry,
          ),
        );
      })
      .finally(() => {
        inFlightControllers.current.delete(controller);
      });
  }

  function onFilesPicked(list: FileList | null) {
    if (!list || list.length === 0) return;
    setErrors([]);
    const files = multiple ? Array.from(list) : [list[0]!];
    const nextErrors: string[] = [];

    if (multiple) {
      const room = FILE_MULTI_CAP - valueRef.current.length - pending.length;
      if (files.length > room) {
        nextErrors.push(`This field holds at most ${FILE_MULTI_CAP} files.`);
        files.length = Math.max(0, room);
      }
    }

    for (const file of files) {
      // The per-field accept gate first — HTML accept is only a hint.
      if (!matchesAccept(file, accept)) {
        nextErrors.push(`“${file.name}” isn’t an accepted type for this field.`);
        continue;
      }
      const problem = preflightFile(file, { maxBytes });
      if (problem !== null) {
        nextErrors.push(problem);
        continue;
      }
      startUpload(file);
    }

    if (nextErrors.length > 0) setErrors(nextErrors);
  }

  function retryUpload(key: string) {
    if (disabled) return;
    const entry = pending.find((p) => p.key === key);
    if (!entry) return;
    setPending((prev) => prev.filter((p) => p.key !== key));
    startUpload(entry.file);
  }

  function removeCommitted(entry: FileFieldEntry) {
    const next = valueRef.current.filter((e) => e !== entry);
    valueRef.current = next;
    onChange(next);
  }

  return (
    <div
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (disabled) return;
        onFilesPicked(e.dataTransfer.files);
      }}
      style={{
        padding: 16,
        border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--line-2)'}`,
        borderRadius: 6,
        background: dragOver ? 'var(--accent-soft)' : 'var(--panel)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        transition: 'background 80ms, border-color 80ms',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 12.5,
          color: 'var(--muted)',
        }}
      >
        <Icon.plus size={13} />
        <span style={{ flex: 1 }}>
          Drop files here, or{' '}
          <button
            type="button"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--accent)',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: 'inherit',
              padding: 0,
              textDecoration: 'underline',
            }}
          >
            browse
          </button>
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
          }}
        >
          {multiple ? 'multi-upload' : 'single file'}
        </span>
      </div>

      {errors.length > 0 && (
        <div
          role="alert"
          style={{
            border: '1px solid var(--danger, #c54343)',
            background: 'var(--danger-soft, rgba(197, 67, 67, 0.08))',
            borderRadius: 4,
            padding: '8px 10px',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            fontSize: 12,
            color: 'var(--danger, #c54343)',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <strong style={{ fontSize: 11.5, letterSpacing: 0.2 }}>
              {errors.length === 1 ? 'Upload error' : `${errors.length} upload errors`}
            </strong>
            <button
              type="button"
              onClick={() => setErrors([])}
              aria-label="Dismiss errors"
              style={{
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                display: 'grid',
                placeItems: 'center',
                padding: 2,
                opacity: 0.8,
              }}
            >
              <Icon.x size={11} />
            </button>
          </div>
          {errors.map((msg, i) => (
            <div key={i} style={{ lineHeight: 1.35 }}>
              {msg}
            </div>
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {pending.map((entry) => (
            <div
              key={entry.key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: entry.error === null ? 'var(--muted)' : 'var(--danger, #c54343)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {entry.error === null ? (
                  entry.file.name
                ) : (
                  <span role="alert">{entry.error}</span>
                )}
              </span>
              {entry.error === null ? (
                <>
                  <span>{entry.percent}%</span>
                  <button
                    type="button"
                    onClick={() => entry.controller.abort()}
                    aria-label={`Cancel upload of ${entry.file.name}`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      display: 'grid',
                      placeItems: 'center',
                      padding: 2,
                    }}
                  >
                    <Icon.x size={11} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => retryUpload(entry.key)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: disabled ? 'var(--dim)' : 'var(--accent)',
                      cursor: disabled ? 'not-allowed' : 'pointer',
                      fontSize: 'inherit',
                      padding: 0,
                      textDecoration: 'underline',
                    }}
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setPending((prev) => prev.filter((p) => p.key !== entry.key))
                    }
                    aria-label={`Dismiss failed upload of ${entry.file.name}`}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      display: 'grid',
                      placeItems: 'center',
                      padding: 2,
                    }}
                  >
                    <Icon.x size={11} />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {value.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
            gap: 10,
          }}
        >
          {value.map((entry, idx) => (
            <FileTile
              key={`${entry.uploadId}-${idx}`}
              entry={entry}
              onRemove={() => removeCommitted(entry)}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept && accept.length > 0 ? accept.join(',') : undefined}
        onChange={(e) => {
          onFilesPicked(e.target.files);
          if (inputRef.current) inputRef.current.value = '';
        }}
        style={{ display: 'none' }}
      />
    </div>
  );
}

function FileTile({
  entry,
  onRemove,
  disabled,
}: {
  entry: FileFieldEntry;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const isImage =
    entry.isImage ?? (entry.mimeType?.startsWith('image/') ?? false);
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 5,
        background: 'var(--panel-2)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          aspectRatio: '1 / 1',
          background: 'var(--panel)',
          display: 'grid',
          placeItems: 'center',
          position: 'relative',
          color: 'var(--dim)',
        }}
      >
        {isImage && entry.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={entry.thumbnailUrl}
            alt={entry.filename}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Icon.doc size={24} />
        )}
        {!disabled && (
          <button
            type="button"
            onClick={onRemove}
            title="Remove"
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              background: 'var(--panel)',
              border: '1px solid var(--line-2)',
              borderRadius: 3,
              padding: 2,
              cursor: 'pointer',
              color: 'var(--muted)',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon.x size={10} />
          </button>
        )}
      </div>
      <div style={{ padding: '6px 8px' }}>
        <div
          style={{
            fontSize: 11.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-2)',
          }}
          title={entry.filename}
        >
          {entry.filename}
        </div>
        <div
          style={{
            fontSize: 10,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
            marginTop: 2,
            display: 'flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <span>{humanSize(entry.sizeBytes)}</span>
          {isImage && <Tag tone="outline">img</Tag>}
        </div>
      </div>
    </div>
  );
}

function toEntry(resp: ConfirmUploadResponse): FileFieldEntry {
  return {
    uploadId: resp.id,
    filename: resp.filename,
    mimeType: resp.mimeType,
    sizeBytes: resp.sizeBytes,
    isImage: resp.isImage,
    thumbnailUrl: resp.thumbnailUrl,
    downloadUrl: resp.downloadUrl,
  };
}
