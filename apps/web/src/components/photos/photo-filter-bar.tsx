import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Icon } from '../ui';
import { buildPhotosHref } from '../../lib/photo-query';

const KINDS: Array<{ value?: string; label: string }> = [
  { value: undefined, label: 'All' },
  { value: 'asset', label: 'Attachments' },
  { value: 'article', label: 'Articles' },
  { value: 'asset_field', label: 'Assets' },
];

/**
 * Filter strip at the top of the company photo gallery (admin +
 * portal): attachment-type pills, an id-filter chip with a clear link,
 * and the photo count. Every link keeps the other active filters.
 *
 * `nonLatest` is the admin audit toggle ("Show orphaned & archived").
 * Pass it only on admin; when it is absent the toggle is not rendered
 * and no link carries `includeNonLatest`.
 */
export function PhotoFilterBar({
  basePath,
  attachedToType,
  attachedToId,
  count,
  nonLatest,
}: {
  basePath: string;
  attachedToType?: string;
  attachedToId?: string;
  count: number;
  nonLatest?: { included: boolean };
}) {
  const includeNonLatest = nonLatest?.included;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        padding: '10px 14px',
        borderBottom: '1px solid var(--line)',
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          minWidth: 0,
        }}
      >
        {KINDS.map((k) => (
          <Link
            key={k.label}
            href={buildPhotosHref(basePath, {
              attachedToType: k.value,
              attachedToId,
              includeNonLatest,
            })}
            style={pillStyle((attachedToType ?? '') === (k.value ?? ''))}
          >
            {k.label}
          </Link>
        ))}
      </div>
      {nonLatest && (
        <Link
          href={buildPhotosHref(basePath, {
            attachedToType,
            attachedToId,
            includeNonLatest: !nonLatest.included,
          })}
          title={
            nonLatest.included
              ? 'Show only images from the current live article body'
              : 'Reveal images that are orphaned, archived, or only in older versions'
          }
          style={pillStyle(nonLatest.included)}
        >
          Show orphaned &amp; archived
        </Link>
      )}
      {attachedToId && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 8px',
            borderRadius: 4,
            background: 'var(--panel-2)',
            border: '1px solid var(--line)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--muted)',
            whiteSpace: 'nowrap',
          }}
        >
          <span>
            id:{' '}
            <span style={{ color: 'var(--text-2)' }}>
              {attachedToId.slice(0, 8)}…
            </span>
          </span>
          <Link
            href={buildPhotosHref(basePath, {
              attachedToType,
              includeNonLatest,
            })}
            style={{ color: 'var(--dim)' }}
            title="Clear id filter"
          >
            <Icon.x size={10} />
          </Link>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 8 }} />
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--muted)',
          whiteSpace: 'nowrap',
          marginLeft: 'auto',
        }}
      >
        {count} photo{count === 1 ? '' : 's'}
        {includeNonLatest ? ' (incl. non-live)' : ''}
      </span>
    </div>
  );
}

function pillStyle(active: boolean): CSSProperties {
  return {
    padding: '4px 10px',
    borderRadius: 4,
    fontSize: 11.5,
    fontFamily: 'var(--font-mono)',
    whiteSpace: 'nowrap',
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--muted)',
    border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`,
  };
}
