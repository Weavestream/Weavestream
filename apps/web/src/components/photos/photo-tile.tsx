import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { Icon, Tag } from '../ui';
import { attachmentLabel } from '../../lib/photo-query';
import type { UploadSummary } from '../../lib/server-api/uploads';

/**
 * One image in the company photo gallery (admin + portal): a square
 * thumbnail that opens the download, the filename, the attachment-kind
 * tag, and the pixel size.
 *
 * Surface-specific parts come in through slots so this tile holds no
 * admin or portal conditionals: `badges` sits after the kind tag (admin
 * link-state badges), and `actions` is the chip row under the meta line
 * (Open / Related / Delete). A null `actions` renders no row.
 */
export function PhotoTile({
  photo,
  badges,
  actions,
}: {
  photo: UploadSummary;
  badges?: ReactNode;
  actions?: ReactNode;
}) {
  const kindLabel = photo.attachedToType
    ? attachmentLabel(photo.attachedToType)
    : 'detached';
  return (
    <div
      style={{
        border: '1px solid var(--line)',
        borderRadius: 6,
        background: 'var(--panel-2)',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <a
        href={photo.downloadUrl ?? '#'}
        target="_blank"
        rel="noreferrer"
        style={{
          aspectRatio: '1 / 1',
          background: 'var(--panel)',
          display: 'block',
          overflow: 'hidden',
        }}
        title={photo.filename}
      >
        {photo.thumbnailUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo.thumbnailUrl}
            alt={photo.filename}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--dim)',
            }}
          >
            <Icon.doc size={22} />
          </div>
        )}
      </a>
      <div
        style={{
          padding: '8px 10px',
          borderTop: '1px solid var(--line)',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div
          title={photo.filename}
          style={{
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {photo.filename}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10.5,
            fontFamily: 'var(--font-mono)',
            color: 'var(--dim)',
          }}
        >
          <Tag tone="outline">{kindLabel}</Tag>
          {badges}
          {photo.width && photo.height && (
            <span>
              {photo.width}×{photo.height}
            </span>
          )}
        </div>
        {actions && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}

const CHIP_TONES: Record<'accent' | 'muted', CSSProperties> = {
  accent: {
    color: 'var(--accent)',
    background: 'var(--accent-soft)',
    border: '1px solid var(--accent-line)',
  },
  muted: {
    color: 'var(--muted)',
    background: 'var(--panel)',
    border: '1px solid var(--line)',
  },
};

/**
 * Compact chip-style link used inside photo tiles. Renders an icon
 * plus a single short word (e.g. "Open", "Related") so we don't waste
 * a 160px-wide tile on a full sentence. Two tones — `accent` for the
 * primary jump-to-source action, `muted` for the secondary "filter to
 * peers" action — keep the visual hierarchy obvious at tile scale.
 */
export function PhotoActionChip({
  href,
  icon,
  label,
  tone = 'accent',
  title,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  tone?: 'accent' | 'muted';
  title: string;
}) {
  return (
    <Link
      href={href}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: 4,
        fontSize: 10.5,
        fontFamily: 'var(--font-mono)',
        lineHeight: 1,
        textDecoration: 'none',
        whiteSpace: 'nowrap',
        ...CHIP_TONES[tone],
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
