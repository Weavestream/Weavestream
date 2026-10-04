import { humanSize } from '@weavestream/shared';
import { Icon } from '../ui';

/** One entry of a FILE field value, as the asset API serializes it. */
export type FileFieldValue = {
  uploadId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage?: boolean;
  thumbnailUrl?: string | null;
  downloadUrl?: string | null;
};

/**
 * Thumbnail grid for a FILE field's uploads on the asset detail pages
 * (admin + portal). Each tile opens the download in a new tab; images
 * with a thumbnail show it, everything else gets a document icon.
 */
export function FileTileRow({ entries }: { entries: FileFieldValue[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))',
        gap: 8,
      }}
    >
      {entries.map((entry) => {
        const isImage = entry.isImage ?? entry.mimeType?.startsWith('image/');
        return (
          <a
            key={entry.uploadId}
            href={entry.downloadUrl ?? '#'}
            target="_blank"
            rel="noreferrer"
            style={{
              border: '1px solid var(--line)',
              borderRadius: 5,
              background: 'var(--panel-2)',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <div
              style={{
                aspectRatio: '1 / 1',
                background: 'var(--panel)',
                display: 'grid',
                placeItems: 'center',
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
                <Icon.doc size={22} />
              )}
            </div>
            <div style={{ padding: '6px 8px' }}>
              <div
                title={entry.filename}
                style={{
                  fontSize: 11.5,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {entry.filename}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--dim)',
                  fontFamily: 'var(--font-mono)',
                  marginTop: 2,
                }}
              >
                {humanSize(entry.sizeBytes)}
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}
