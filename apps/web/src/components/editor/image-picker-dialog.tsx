'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Btn, Dialog, Icon, useToast } from '../ui';
import { apiFetch } from '../../lib/api';
import { copyToClipboard } from '../../lib/clipboard';
import {
  describeUploadError,
  preflightFile,
  uploadFile,
} from '../../lib/upload-client';

/**
 * Image picker dialog used by the Markdown article editor. Three tabs:
 *
 *   - Upload: file picker that pipes through `uploadFile()` and inserts
 *     the resulting Markdown image on success.
 *   - This article: thumbnails for every upload already referenced by
 *     the current draft body (computed client-side via the same regex
 *     `extractEmbeddedUploadIds` uses on the server).
 *   - Library: paginated grid of every article-attached image in the
 *     company, via `GET /companies/:companyId/photos?attachedToType=article`.
 *
 * Inserted Markdown matches what Tiptap embeds so the article body
 * round-trips losslessly through `markdownToTiptapDoc` /
 * `tiptapDocToMarkdown`:
 *
 *   ![${filename}](/api/v1/companies/${companyId}/uploads/${id}/image)
 */

type Tab = 'upload' | 'article' | 'library';

type UploadRow = {
  id: string;
  filename: string;
  thumbnailUrl: string | null;
  width: number | null;
  height: number | null;
  isImage: boolean;
};

type ListResponse = {
  items: UploadRow[];
  nextCursor: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  companyId: string;
  currentBody: string;
  onPick: (markdown: string) => void;
};

const UPLOAD_URL_RE =
  /\/api\/v1\/companies\/[0-9a-f-]{36}\/uploads\/([0-9a-f-]{36})/gi;

function extractIdsFromBody(body: string): string[] {
  const ids = new Set<string>();
  UPLOAD_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UPLOAD_URL_RE.exec(body)) !== null) {
    ids.add(match[1]!.toLowerCase());
  }
  return Array.from(ids);
}

function buildEmbedUrl(companyId: string, uploadId: string): string {
  return `/api/v1/companies/${companyId}/uploads/${uploadId}/image`;
}

function buildThumbUrl(companyId: string, uploadId: string): string {
  return `/api/v1/companies/${companyId}/uploads/${uploadId}/image?v=thumb`;
}

function buildMarkdown(companyId: string, row: { id: string; filename: string }): string {
  const safeAlt = row.filename.replace(/[\[\]]/g, '');
  return `![${safeAlt}](${buildEmbedUrl(companyId, row.id)})`;
}

export function ImagePickerDialog({
  open,
  onClose,
  companyId,
  currentBody,
  onPick,
}: Props) {
  const [tab, setTab] = useState<Tab>('upload');
  const toast = useToast();

  useEffect(() => {
    if (open) setTab('upload');
  }, [open]);

  return (
    <Dialog open={open} onClose={onClose} title="Insert image" width={720}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Tabs tab={tab} setTab={setTab} />
        {tab === 'upload' && (
          <UploadTab
            companyId={companyId}
            onUploaded={(row) => {
              onPick(buildMarkdown(companyId, row));
            }}
          />
        )}
        {tab === 'article' && (
          <ArticleTab
            companyId={companyId}
            currentBody={currentBody}
            onPick={(row) => onPick(buildMarkdown(companyId, row))}
            onCopy={async (row) => {
              const ok = await copyToClipboard(buildEmbedUrl(companyId, row.id));
              toast.push(ok ? 'URL copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
            }}
          />
        )}
        {tab === 'library' && (
          <LibraryTab
            companyId={companyId}
            onPick={(row) => onPick(buildMarkdown(companyId, row))}
            onCopy={async (row) => {
              const ok = await copyToClipboard(buildEmbedUrl(companyId, row.id));
              toast.push(ok ? 'URL copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
            }}
          />
        )}
      </div>
    </Dialog>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const opts: Array<{ id: Tab; label: string }> = [
    { id: 'upload', label: 'Upload' },
    { id: 'article', label: 'This article' },
    { id: 'library', label: 'Library' },
  ];
  return (
    <div
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: '1px solid var(--line)',
      }}
    >
      {opts.map((o) => {
        const active = tab === o.id;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => setTab(o.id)}
            style={{
              background: 'transparent',
              border: 0,
              padding: '8px 12px',
              fontSize: 12.5,
              fontWeight: active ? 600 : 500,
              color: active ? 'var(--text)' : 'var(--muted)',
              borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function UploadTab({
  companyId,
  onUploaded,
}: {
  companyId: string;
  onUploaded: (row: { id: string; filename: string }) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const maxBytes = useMemo<number | null>(() => {
    const raw = process.env.NEXT_PUBLIC_MAX_UPLOAD_MB;
    if (!raw) return null;
    const mb = Number.parseInt(raw, 10);
    return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : null;
  }, []);

  const handleFile = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setError(null);
      if (!file.type.startsWith('image/')) {
        setError(`“${file.name}” is not an image.`);
        return;
      }
      const preflight = preflightFile(file, { maxBytes });
      if (preflight) {
        setError(preflight);
        return;
      }
      setUploading(true);
      try {
        const upload = await uploadFile({
          companyId,
          file,
          attachTo: { type: 'article' },
        });
        onUploaded({ id: upload.id, filename: upload.filename });
        toast.push('Image inserted.', 'ok');
      } catch (err) {
        setError(describeUploadError(err, file.name));
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [companyId, maxBytes, onUploaded, toast],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => void handleFile(e.target.files?.[0] ?? undefined)}
      />
      <div
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(e) => {
          e.preventDefault();
          if (uploading) return;
          const file = e.dataTransfer.files?.[0];
          if (file) void handleFile(file);
        }}
        style={{
          border: '1px dashed var(--line-2)',
          borderRadius: 8,
          padding: 32,
          textAlign: 'center',
          background: 'var(--panel-2)',
          color: 'var(--muted)',
          fontSize: 13,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
          <Icon.image size={26} />
        </div>
        <div style={{ marginBottom: 10, color: 'var(--text-2)' }}>
          Drop an image here or
        </div>
        <Btn
          kind="solid"
          icon={Icon.plus}
          loading={uploading}
          onClick={() => inputRef.current?.click()}
        >
          Choose image…
        </Btn>
      </div>
      {error && (
        <div
          style={{
            fontSize: 12,
            color: 'var(--danger)',
            background: 'var(--danger-soft)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '8px 10px',
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

function ArticleTab({
  companyId,
  currentBody,
  onPick,
  onCopy,
}: {
  companyId: string;
  currentBody: string;
  onPick: (row: { id: string; filename: string }) => void;
  onCopy: (row: { id: string; filename: string }) => void;
}) {
  const ids = useMemo(() => extractIdsFromBody(currentBody), [currentBody]);
  const [rows, setRows] = useState<UploadRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ids.length === 0) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const results = await Promise.all(
        ids.map((id) =>
          apiFetch<UploadRow>(`/companies/${companyId}/uploads/${id}`).then(
            (res) => (res.ok && res.data ? res.data : null),
          ),
        ),
      );
      if (cancelled) return;
      // `GET /uploads/:id` returns `thumbnailUrl: null` by design — the
      // single-row serializer leaves URL fields blank so audit / job
      // payloads don't bake them in. Hydrate the same-origin streaming
      // URL client-side so the tile thumbnails render. This matches the
      // shape `listPhotos` returns for the Library tab.
      const valid = results
        .filter((r): r is UploadRow => r !== null && r.isImage)
        .map((r) => ({
          ...r,
          thumbnailUrl: r.thumbnailUrl ?? buildThumbUrl(companyId, r.id),
        }));
      setRows(valid);
      setLoading(false);
    })().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'Could not load images.');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId, ids]);

  if (loading) return <Hint>Loading…</Hint>;
  if (error) return <Hint danger>{error}</Hint>;
  if (!rows || rows.length === 0)
    return (
      <Hint>
        This article doesn’t reference any images yet. Upload one from the
        Upload tab or pick from the Library.
      </Hint>
    );

  return <Grid items={rows} onPick={onPick} onCopy={onCopy} />;
}

function LibraryTab({
  companyId,
  onPick,
  onCopy,
}: {
  companyId: string;
  onPick: (row: { id: string; filename: string }) => void;
  onCopy: (row: { id: string; filename: string }) => void;
}) {
  const [items, setItems] = useState<UploadRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      params.set('attachedToType', 'article');
      params.set('limit', '60');
      if (cursor) params.set('cursor', cursor);
      const res = await apiFetch<ListResponse>(
        `/companies/${companyId}/photos?${params.toString()}`,
      );
      if (!res.ok || !res.data) {
        setError('Could not load images.');
        if (!append) setItems([]);
      } else {
        setItems((prev) =>
          append && prev ? [...prev, ...res.data!.items] : res.data!.items,
        );
        setNextCursor(res.data.nextCursor);
      }
      setLoading(false);
      setLoadingMore(false);
    },
    [companyId],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const filtered = useMemo(() => {
    if (!items) return null;
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) => r.filename.toLowerCase().includes(q));
  }, [items, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search filename…"
          style={{
            flex: 1,
            height: 28,
            padding: '0 10px',
            fontSize: 12.5,
            background: 'var(--panel-2)',
            border: '1px solid var(--line-2)',
            borderRadius: 5,
            color: 'var(--text)',
          }}
        />
      </div>
      {loading ? (
        <Hint>Loading…</Hint>
      ) : error ? (
        <Hint danger>{error}</Hint>
      ) : !filtered || filtered.length === 0 ? (
        <Hint>
          {query
            ? 'No images match that filename.'
            : 'No article images uploaded yet.'}
        </Hint>
      ) : (
        <Grid items={filtered} onPick={onPick} onCopy={onCopy} />
      )}
      {nextCursor && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Btn
            kind="ghost"
            loading={loadingMore}
            onClick={() => void load(nextCursor, true)}
          >
            Load more
          </Btn>
        </div>
      )}
    </div>
  );
}

function Grid({
  items,
  onPick,
  onCopy,
}: {
  items: UploadRow[];
  onPick: (row: { id: string; filename: string }) => void;
  onCopy: (row: { id: string; filename: string }) => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
        gap: 10,
        maxHeight: 480,
        overflowY: 'auto',
        paddingRight: 4,
      }}
    >
      {items.map((row) => (
        <Tile key={row.id} row={row} onPick={onPick} onCopy={onCopy} />
      ))}
    </div>
  );
}

function Tile({
  row,
  onPick,
  onCopy,
}: {
  row: UploadRow;
  onPick: (row: { id: string; filename: string }) => void;
  onCopy: (row: { id: string; filename: string }) => void;
}) {
  const [hover, setHover] = useState(false);
  const tile: CSSProperties = {
    position: 'relative',
    border: '1px solid var(--line)',
    borderRadius: 6,
    background: 'var(--panel-2)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    cursor: 'pointer',
    textAlign: 'left',
    padding: 0,
    transition: 'border-color 120ms ease, transform 120ms ease',
    borderColor: hover ? 'var(--accent)' : 'var(--line)',
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onPick({ id: row.id, filename: row.filename })}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick({ id: row.id, filename: row.filename });
        }
      }}
      style={tile}
      title={row.filename}
    >
      <div
        style={{
          aspectRatio: '1 / 1',
          background: 'var(--panel)',
          display: 'grid',
          placeItems: 'center',
          overflow: 'hidden',
        }}
      >
        {row.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={row.thumbnailUrl}
            alt={row.filename}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <Icon.image size={24} />
        )}
      </div>
      <div
        style={{
          padding: '6px 8px',
          borderTop: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
        }}
      >
        <div
          style={{
            flex: 1,
            fontSize: 11.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: 'var(--text-2)',
          }}
        >
          {row.filename}
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCopy({ id: row.id, filename: row.filename });
          }}
          title="Copy URL"
          style={{
            background: 'transparent',
            border: 0,
            padding: 4,
            color: 'var(--muted)',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          <Icon.copy size={12} />
        </button>
      </div>
    </div>
  );
}

function Hint({
  children,
  danger,
}: {
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div
      style={{
        padding: 28,
        textAlign: 'center',
        fontSize: 12.5,
        color: danger ? 'var(--danger)' : 'var(--muted)',
        background: 'var(--panel-2)',
        border: '1px solid var(--line)',
        borderRadius: 6,
      }}
    >
      {children}
    </div>
  );
}
