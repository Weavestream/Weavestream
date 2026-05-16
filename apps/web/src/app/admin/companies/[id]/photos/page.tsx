import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Photos' };
import {
  getCompanyDetail,
  getMe,
  getSettings,
  listPhotos,
  throwUnlessFound,
  type UploadSummary,
} from '../../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Icon, Panel, Tag } from '../../../../../components/ui';
import { buildTerm, lower } from '../../../../../lib/term';
import { companyCrumbs } from '../../../../../lib/company-crumbs';

/**
 * Phase 4 per-company photo gallery. `Upload` rows with `isImage=true`
 * light up here, filtered by optional `attachedToType`
 * (asset | article | asset_field) so operators can audit everything
 * uploaded against a single entity from one place.
 */
export default async function CompanyPhotosPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId } = await params;
  const sp = await searchParams;
  await getMe();
  const term = buildTerm(await getSettings());

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const attachedToType = readString(sp.attachedToType);
  const attachedToId = readString(sp.attachedToId);
  const cursor = readString(sp.cursor);

  const page = await listPhotos(companyId, {
    attachedToType,
    attachedToId,
    limit: 60,
    cursor,
  });

  const basePath = `/admin/companies/${companyId}/photos`;

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Photos' })}
        title="Photos"
        description={`Every image uploaded to this ${lower(
          term.one,
        )} — attachments, article images, and asset-field captures.`}
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
            <PhotoGrid items={page.items} companyId={companyId} />
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
  companyId,
}: {
  items: UploadSummary[];
  companyId: string;
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
        <PhotoTile key={photo.id} photo={photo} companyId={companyId} />
      ))}
    </div>
  );
}

function PhotoTile({
  photo,
  companyId,
}: {
  photo: UploadSummary;
  companyId: string;
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
        {(() => {
          const linkInfo = resolveSourceLink(companyId, photo);
          if (!linkInfo) return null;
          return (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
              }}
            >
              <ActionChip
                href={linkInfo.sourceHref}
                icon={<Icon.ext size={10} />}
                label="Open"
                tone="accent"
                title={
                  linkInfo.sourceTitle
                    ? `Open ${linkInfo.label}: ${linkInfo.sourceTitle}`
                    : `Open source ${linkInfo.label}`
                }
              />
              {linkInfo.filterHref && (
                <ActionChip
                  href={linkInfo.filterHref}
                  icon={<Icon.grid size={10} />}
                  label="Related"
                  tone="muted"
                  title={`View all photos for this ${linkInfo.label}`}
                />
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/**
 * Compact chip-style link used inside photo tiles. Renders an icon
 * plus a single short word (e.g. "Open", "Related") so we don't waste
 * a 160px-wide tile on a full sentence. Two tones — `accent` for the
 * primary jump-to-source action, `muted` for the secondary "filter to
 * peers" action — keep the visual hierarchy obvious at tile scale.
 */
function ActionChip({
  href,
  icon,
  label,
  tone,
  title,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  tone: 'accent' | 'muted';
  title: string;
}) {
  const styles =
    tone === 'accent'
      ? {
          color: 'var(--accent)',
          background: 'var(--accent-soft)',
          border: '1px solid var(--accent-line)',
        }
      : {
          color: 'var(--muted)',
          background: 'var(--panel)',
          border: '1px solid var(--line)',
        };
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
        ...styles,
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

function filterHref(
  companyId: string,
  attachedToType: string,
  attachedToId: string,
): string {
  return `/admin/companies/${companyId}/photos?attachedToType=${encodeURIComponent(attachedToType)}&attachedToId=${encodeURIComponent(attachedToId)}`;
}

/**
 * Pick the best "open source X" / "view all for this X" link for a
 * photo tile. Asset and asset_field uploads ship with an
 * `attachedToId` and can deep-link directly. Article uploads never
 * carry an id — the owning article is resolved server-side via
 * `sourceArticle` (a body-scan of active articles), so we use that
 * here instead. Returns null when no usable link can be built (e.g.
 * an article image that no longer appears in any article body).
 */
function resolveSourceLink(
  companyId: string,
  photo: UploadSummary,
): {
  label: string;
  sourceHref: string;
  filterHref: string | null;
  sourceTitle: string | null;
} | null {
  if (!photo.attachedToType) return null;
  const label = attachmentLabel(photo.attachedToType).toLowerCase();
  if (photo.attachedToType === 'article') {
    if (!photo.sourceArticle) return null;
    return {
      label,
      sourceHref: `/admin/companies/${companyId}/articles/${encodeURIComponent(
        photo.sourceArticle.id,
      )}`,
      filterHref: null,
      sourceTitle: photo.sourceArticle.title,
    };
  }
  if (!photo.attachedToId) return null;
  const href = sourceHref(companyId, photo.attachedToType, photo.attachedToId);
  if (!href) return null;
  return {
    label,
    sourceHref: href,
    filterHref: filterHref(companyId, photo.attachedToType, photo.attachedToId),
    sourceTitle: null,
  };
}

/**
 * Human-facing label for an upload's `attachedToType`. The raw DB
 * values (asset / asset_field / article) don't match the vocabulary
 * we show in the filter bar: `asset` is a generic attachment to an
 * asset, while `asset_field` is a photo stored on a FILE field and is
 * what operators think of as "the asset's photo". Keep this mapping
 * in one place so the filter pills, tile badges, and the "open
 * source X" / "view all for this X" links stay consistent.
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

/**
 * Map an `(attachedToType, attachedToId)` pair back to the page that
 * represents the source entity. `asset_field` uploads (photos captured
 * inline on an asset's FILE field) point back at the parent asset —
 * the attachedToId IS the asset id. Returns null for attachment types
 * that don't yet have a dedicated detail page.
 */
function sourceHref(
  companyId: string,
  attachedToType: string,
  attachedToId: string,
): string | null {
  switch (attachedToType) {
    case 'asset':
    case 'asset_field':
      return `/admin/companies/${companyId}/assets/${encodeURIComponent(attachedToId)}`;
    case 'article':
      return `/admin/companies/${companyId}/articles/${encodeURIComponent(attachedToId)}`;
    default:
      return null;
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
      <div>No photos yet for the current filter.</div>
      <div
        style={{
          marginTop: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          color: 'var(--dim)',
        }}
      >
        Attach an image to any asset or article and it will appear here.
      </div>
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
