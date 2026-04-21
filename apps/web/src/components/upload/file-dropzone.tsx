'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { Btn, Icon, Tag, useToast } from '../ui';
import {
  describeUploadError,
  preflightFile,
  uploadFile,
  type ConfirmUploadResponse,
  type UploadAttachmentType,
} from '../../lib/upload-client';

/**
 * Dropzone used by `FILE` fields on assets and (eventually) articles.
 * Each successful upload is appended to the `value` array; the caller
 * owns persistence (i.e. writes the list back into the field value).
 * The dropzone itself does not know anything about field semantics —
 * it only speaks "upload N files, emit N `ConfirmUploadResponse`s".
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

export function FileDropzone({
  companyId,
  value,
  onChange,
  attachTo,
  disabled,
  multiple = true,
  accept,
}: {
  companyId: string;
  value: FileFieldEntry[];
  onChange: (next: FileFieldEntry[]) => void;
  attachTo?: { type: UploadAttachmentType; id?: string };
  disabled?: boolean;
  multiple?: boolean;
  accept?: string;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<Record<string, number>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // Read the public upload-size limit once. `NEXT_PUBLIC_*` envs are
  // statically inlined by Next at build time, so this is safe to read
  // unconditionally on the client.
  const maxBytes = useMemo<number | null>(() => {
    const raw = process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;
    if (!raw) return null;
    const mb = Number.parseInt(raw, 10);
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : null;
  }, []);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const list = Array.from(files);
      setErrors([]);
      const next: FileFieldEntry[] = [...value];
      const nextErrors: string[] = [];

      for (const file of list) {
        // Cheap local validation first — reject unsupported types and
        // oversize files before spinning the uploader. The server still
        // has the final word.
        const preflightMsg = preflightFile(file, { maxBytes });
        if (preflightMsg) {
          nextErrors.push(preflightMsg);
          toast.push(preflightMsg, 'danger');
          continue;
        }

        const key = `${file.name}:${file.size}:${Date.now()}`;
        setBusy((b) => ({ ...b, [key]: 0 }));
        try {
          const resp = await uploadFile({
            companyId,
            file,
            attachTo,
            onProgress: (p) => setBusy((b) => ({ ...b, [key]: p.percent })),
          });
          next.push(toEntry(resp));
          onChange([...next]);
        } catch (err) {
          const msg = describeUploadError(err, file.name);
          nextErrors.push(msg);
          toast.push(msg, 'danger');
        } finally {
          setBusy((b) => {
            const copy = { ...b };
            delete copy[key];
            return copy;
          });
        }
      }

      if (nextErrors.length > 0) setErrors(nextErrors);
    },
    [attachTo, companyId, maxBytes, onChange, toast, value],
  );

  const inFlight = Object.entries(busy);

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
        handleFiles(e.dataTransfer.files);
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

      {inFlight.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {inFlight.map(([key, pct]) => (
            <div
              key={key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 11,
                color: 'var(--muted)',
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
                {key.split(':')[0]}
              </span>
              <span>{pct}%</span>
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
              onRemove={() => {
                const next = value.slice();
                next.splice(idx, 1);
                onChange(next);
              }}
              disabled={disabled}
            />
          ))}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple={multiple}
        accept={accept}
        onChange={(e) => {
          handleFiles(e.target.files);
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

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export { Btn };
