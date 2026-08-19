'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Btn, Icon, Panel, useToast } from '../ui';
import { FormattedRelative } from '../../lib/timezone-context';
import { apiFetch } from '../../lib/api';
import { humanSize } from '@weavestream/shared';
import {
  describeUploadError,
  preflightFile,
  uploadFile,
  type ConfirmUploadResponse,
  type UploadAttachmentType,
} from '../../lib/upload-client';

/**
 * Sidebar "Attachments" panel used on asset and article detail pages.
 *
 * Unlike the field-level `FileDropzone` (which owns an array inside a
 * form), this panel is stateless with respect to the page: every
 * upload, delete, and read hits the server directly and the panel
 * re-fetches on changes. That makes it safe to drop onto detail pages
 * that were already server-rendered without plumbing form state.
 *
 * The list is minted via `GET /companies/:id/uploads` with both
 * `attachedToType` and `attachedToId` filters — the endpoint refuses
 * to return a tenant-wide dump, matching the panel's per-entity scope.
 */

type AttachmentKind = Exclude<UploadAttachmentType, 'asset_field'>;

type Attachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
  thumbnailUrl: string | null;
  downloadUrl: string | null;
  createdAt: string;
  uploaderId: string | null;
};

type ListResponse = {
  items: Attachment[];
  nextCursor: string | null;
};

interface Props {
  companyId: string;
  entityType: AttachmentKind;
  entityId: string;
  /** Writer can upload and delete. Readers see a read-only list. */
  editable: boolean;
}

export function AttachmentsPanel({ companyId, entityType, entityId, editable }: Props) {
  const [items, setItems] = useState<Attachment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const maxBytes = useMemo<number | null>(() => {
    const raw = process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;
    if (!raw) return null;
    const mb = Number.parseInt(raw, 10);
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : null;
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await apiFetch<ListResponse>(
      `/companies/${companyId}/uploads?attachedToType=${entityType}&attachedToId=${entityId}`,
    );
    if (!res.ok || !res.data) {
      setError('Could not load attachments.');
      setItems(null);
    } else {
      setItems(res.data.items);
    }
    setLoading(false);
  }, [companyId, entityType, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const list = Array.from(files);
      setErrors([]);
      const nextErrors: string[] = [];

      for (const file of list) {
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
            attachTo: { type: entityType, id: entityId },
            onProgress: (p) => setBusy((b) => ({ ...b, [key]: p.percent })),
          });
          // Optimistically prepend until the refetch confirms.
          setItems((prev) => (prev ? [toAttachment(resp), ...prev] : [toAttachment(resp)]));
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
      void load();
    },
    [companyId, entityType, entityId, load, maxBytes, toast],
  );

  async function handleDelete(att: Attachment) {
    if (!confirm(`Delete "${att.filename}"?`)) return;
    setDeleting((d) => ({ ...d, [att.id]: true }));
    const res = await apiFetch(`/companies/${companyId}/uploads/${att.id}`, {
      method: 'DELETE',
    });
    setDeleting((d) => {
      const copy = { ...d };
      delete copy[att.id];
      return copy;
    });
    if (!res.ok) {
      const problem = (res.problem ?? res.data) as
        | { detail?: string; message?: string }
        | null;
      toast.push(problem?.detail ?? problem?.message ?? 'Could not delete.', 'danger');
      return;
    }
    toast.push('Attachment deleted.', 'ok');
    setItems((prev) => (prev ? prev.filter((i) => i.id !== att.id) : prev));
  }

  const inFlight = Object.entries(busy);
  const count = items?.length ?? 0;

  return (
    <Panel
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon.doc size={12} style={{ color: 'var(--accent)' }} />
          Attachments
          {count > 0 && (
            <span
              style={{
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
                marginLeft: 2,
              }}
            >
              · {count}
            </span>
          )}
        </span>
      }
      actions={
        editable ? (
          <Btn
            kind="ghost"
            size="sm"
            icon={Icon.plus}
            onClick={() => inputRef.current?.click()}
            aria-label="Upload attachment"
          >
            Upload
          </Btn>
        ) : null
      }
    >
      {editable && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          style={{
            padding: '10px 12px',
            border: `1px dashed ${dragOver ? 'var(--accent)' : 'var(--line-2)'}`,
            borderRadius: 5,
            background: dragOver ? 'var(--accent-soft)' : 'var(--panel-2)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11.5,
            color: 'var(--muted)',
            transition: 'background 80ms, border-color 80ms',
            marginBottom: count > 0 || inFlight.length > 0 ? 10 : 0,
          }}
        >
          <Icon.plus size={11} />
          <span style={{ flex: 1 }}>
            Drop files or <span style={{ color: 'var(--accent)' }}>browse</span>
          </span>
        </div>
      )}

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
            fontSize: 11.5,
            color: 'var(--danger, #c54343)',
            marginBottom: 10,
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
            <strong style={{ fontSize: 11, letterSpacing: 0.2 }}>
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
              <Icon.x size={10} />
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
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            marginBottom: 10,
          }}
        >
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

      {loading ? (
        <div style={emptyStyle}>Loading…</div>
      ) : error ? (
        <div style={{ ...emptyStyle, color: 'var(--danger)' }}>{error}</div>
      ) : !items || items.length === 0 ? (
        <div style={emptyStyle}>
          {editable ? 'Drop files above to attach.' : 'No attachments yet.'}
        </div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {items.map((att) => (
            <li key={att.id}>
              <AttachmentRow
                attachment={att}
                editable={editable}
                deleting={!!deleting[att.id]}
                onDelete={() => handleDelete(att)}
              />
            </li>
          ))}
        </ul>
      )}

      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={(e) => {
          void handleFiles(e.target.files);
          if (inputRef.current) inputRef.current.value = '';
        }}
        style={{ display: 'none' }}
      />
    </Panel>
  );
}

function AttachmentRow({
  attachment,
  editable,
  deleting,
  onDelete,
}: {
  attachment: Attachment;
  editable: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const isImage = attachment.isImage || attachment.mimeType?.startsWith('image/');
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 4px',
        borderRadius: 4,
        transition: 'background-color 120ms ease',
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--panel-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      <span
        aria-hidden
        style={{
          width: 28,
          height: 28,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--muted)',
          flexShrink: 0,
          borderRadius: 3,
          background: 'var(--panel)',
          overflow: 'hidden',
        }}
      >
        {isImage && attachment.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={attachment.thumbnailUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Icon.doc size={14} />
        )}
      </span>
      <a
        href={attachment.downloadUrl ?? '#'}
        target="_blank"
        rel="noreferrer"
        style={{
          flex: 1,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
          color: 'var(--text)',
          textDecoration: 'none',
        }}
        title={attachment.filename}
      >
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {attachment.filename}
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--muted)',
            fontFamily: 'var(--font-mono)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span>{humanSize(attachment.sizeBytes)}</span>
          <span style={{ color: 'var(--dim)' }}>·</span>
          <span>
            <FormattedRelative value={attachment.createdAt} />
          </span>
        </span>
      </a>
      {editable && (
        <button
          type="button"
          onClick={onDelete}
          disabled={deleting}
          aria-label="Delete attachment"
          title="Delete attachment"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: deleting ? 'wait' : 'pointer',
            padding: 4,
            borderRadius: 3,
            display: 'grid',
            placeItems: 'center',
            opacity: deleting ? 0.5 : 1,
          }}
          onMouseEnter={(e) => {
            if (!deleting) e.currentTarget.style.color = 'var(--danger)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = 'var(--muted)';
          }}
        >
          <Icon.trash size={11} />
        </button>
      )}
    </div>
  );
}

function toAttachment(resp: ConfirmUploadResponse): Attachment {
  return {
    id: resp.id,
    filename: resp.filename,
    mimeType: resp.mimeType,
    sizeBytes: resp.sizeBytes,
    isImage: resp.isImage,
    thumbnailUrl: resp.thumbnailUrl,
    downloadUrl: resp.downloadUrl,
    createdAt: resp.createdAt,
    uploaderId: null,
  };
}

const emptyStyle = {
  padding: '14px 4px',
  fontSize: 12,
  color: 'var(--muted)',
  textAlign: 'center' as const,
};
