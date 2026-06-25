import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  requireMe,
  listPhotos,
  type UploadSummary,
} from '../../../../lib/server-api';
import { resolvePortalCompany } from '../../../../lib/portal-company';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Icon, LayoutSwatch, Panel, Tag } from '../../../../components/ui';

/**
 * Portal photos gallery — read-only view of the company's image
 * uploads. Filters mirror the admin page so a client admin can drill
 * into attachments for a specific asset or article. CLIENT_USER still
 * has `upload.read` so it remains accessible to all portal members.
 */
export default async function PortalPhotosPage({
  params,
  searchParams,
}: {
  params: Promise<{ companySlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { companySlug } = await params;
  const sp = await searchParams;
  const me = await requireMe();
  const company = await resolvePortalCompany(me, companySlug);
  const companyId = company.id;

  const attachedToType = readString(sp.attachedToType);
  const attachedToId = readString(sp.attachedToId);
  const cursor = readString(sp.cursor);

  const page = await listPhotos(companyId, {
    attachedToType,
    attachedToId,
    limit: 48,
    cursor,
  });

  const basePath = `/portal/${companySlug}/photos`;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: company.name },
          { label: 'Photos' },
        ]}
        leading={<LayoutSwatch icon="image" color="var(--accent)" size={48} />}
        title="Photos"
        description="Images stored against this workspace's assets and articles."
      />
      <PageBody>
        <Panel noPad>
          <FilterBar
            basePath={basePath}
            attachedToType={attachedToType}
            attachedToId={attachedToId}
            count={page.items.length}
          />
          {page.items.length === 0 ? (
            <EmptyState />
          ) : (
            <PhotoGrid items={page.items} companySlug={companySlug} />
          )}
          <Pagination
            basePath={basePath}
            nextCursor={page.nextCursor}
            attachedToType={attachedToType}
            attachedToId={attachedToId}
          />
        </Panel>
      </PageBody>
    </>
  );
}

function readString(v: string | string[] | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  return v.length > 0 ? v : undefined;
}

function FilterBar({
  basePath,
  attachedToType,
  attachedToId,
  count,
}: {
  basePath: string;
  attachedToType?: string;
  attachedToId?: string;
  count: number;
}) {
  const kinds: Array<{ value?: string; label: string }> = [
    { value: undefined, label: 'All' },
    { value: 'asset', label: 'Attachments' },
    { value: 'article', label: 'Articles' },
    { value: 'asset_field', label: 'Assets' },
  ];
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
        {kinds.map((k) => {
          const active = (attachedToType ?? '') === (k.value ?? '');
          const href = k.value
            ? `${basePath}?attachedToType=${k.value}${attachedToId ? `&attachedToId=${attachedToId}` : ''}`
            : basePath;
          return (
            <Link
              key={k.label}
              href={href}
              style={{
                padding: '4px 10px',
                borderRadius: 4,
                fontSize: 11.5,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'nowrap',
                background: active ? 'var(--accent-soft)' : 'transparent',
                color: active ? 'var(--accent)' : 'var(--muted)',
                border: `1px solid ${active ? 'var(--accent-line)' : 'var(--line)'}`,
              }}
            >
              {k.label}
            </Link>
          );
        })}
      </div>
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
            href={
              attachedToType
                ? `${basePath}?attachedToType=${attachedToType}`
                : basePath
            }
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
      </span>
    </div>
  );
}

function PhotoGrid({
  items,
  companySlug,
}: {
  items: UploadSummary[];
  companySlug: string;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
        gap: 10,
        padding: 14,
      }}
    >
      {items.map((photo) => (
        <PhotoTile key={photo.id} photo={photo} companySlug={companySlug} />
      ))}
    </div>
  );
}

function PhotoTile({
  photo,
  companySlug,
}: {
  photo: UploadSummary;
  companySlug: string;
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
          {photo.width && photo.height && (
            <span>
              {photo.width}×{photo.height}
            </span>
          )}
        </div>
        {photo.attachedToType === 'article' && photo.sourceArticle && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
            }}
          >
            <ActionChip
              href={`/portal/${companySlug}/articles/${encodeURIComponent(
                photo.sourceArticle.slug,
              )}`}
              icon={<Icon.ext size={10} />}
              label="Open"
              title={`Open article: ${photo.sourceArticle.title}`}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact chip-style link rendered inside photo tiles. Mirrors the
 * admin photos page so the visual language is identical across admin
 * and portal views. Icon + single-word label keeps the action visible
 * without consuming the tile's narrow width.
 */
function ActionChip({
  href,
  icon,
  label,
  title,
}: {
  href: string;
  icon: ReactNode;
  label: string;
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
        color: 'var(--accent)',
        background: 'var(--accent-soft)',
        border: '1px solid var(--accent-line)',
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

/**
 * Human-facing label for an upload's `attachedToType`. Kept in sync
 * with the admin photos page so the filter pills and the tile badge
 * use the same vocabulary.
 */
function attachmentLabel(attachedToType: string): string {
  switch (attachedToType) {
    case 'asset':
      return 'Attachment';
    case 'asset_field':
      return 'Asset';
    case 'article':
      return 'Article';
    default:
      return attachedToType.replace('_', ' ');
  }
}

function EmptyState() {
  return (
    <div
      style={{
        padding: 48,
        textAlign: 'center',
        color: 'var(--muted)',
        fontSize: 13,
      }}
    >
      <div style={{ fontSize: 24, marginBottom: 8 }}>
        <Icon.doc size={24} />
      </div>
      <div>No photos shared with your workspace yet.</div>
    </div>
  );
}

function Pagination({
  basePath,
  nextCursor,
  attachedToType,
  attachedToId,
}: {
  basePath: string;
  nextCursor: string | null;
  attachedToType?: string;
  attachedToId?: string;
}) {
  if (!nextCursor) return null;
  const params = new URLSearchParams();
  if (attachedToType) params.set('attachedToType', attachedToType);
  if (attachedToId) params.set('attachedToId', attachedToId);
  params.set('cursor', nextCursor);
  return (
    <div
      style={{
        padding: '10px 14px',
        borderTop: '1px solid var(--line)',
        display: 'flex',
        justifyContent: 'flex-end',
      }}
    >
      <Link
        href={`${basePath}?${params.toString()}`}
        style={{
          fontSize: 11.5,
          fontFamily: 'var(--font-mono)',
          color: 'var(--accent)',
        }}
      >
        Load more →
      </Link>
    </div>
  );
}
