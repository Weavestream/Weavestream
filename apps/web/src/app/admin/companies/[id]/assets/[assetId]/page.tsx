import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import React, { Fragment } from 'react';
import {
  getAsset,
  getCompanyDetail,
  getMe,
  getSettings,
  throwUnlessFound,
  type AssetSummary,
} from '../../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../../components/shell/page-header';
import { Icon, LayoutSwatch, Panel, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { RichTextView } from '../../../../../../components/editor/rich-text-view';
import { LinkedItemsPanel } from '../../../../../../components/relations';
import { AttachmentsPanel } from '../../../../../../components/upload/attachments-panel';
import { CredentialsPanel } from '../../../../../../components/passwords/credentials-panel';
import { vaultLinkLabel, vaultLinkUrl } from '../../../../../../lib/vault-link';
import { AssetChatContext } from '../../../../../../components/chat-panel/asset-chat-context';
import { AssetActions } from './asset-actions';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}): Promise<Metadata> {
  const { id, assetId } = await params;
  const asset = await getAsset(id, assetId);
  return asset ? { title: asset.name } : {};
}

/**
 * Asset detail. Mirrors the design template: header chip strip + layout
 * swatch, two-column key/value grid of stored field values, freeform
 * notes block (if the layout carries a RICH_TEXT/TEXTAREA field), and a
 * right rail with the Linked items panel backed by the Relation table.
 */
export default async function AssetDetailPage({
  params,
}: {
  params: Promise<{ id: string; assetId: string }>;
}) {
  const { id: companyId, assetId } = await params;
  const me = (await getMe())!;
  const term = buildTerm(await getSettings());
  const [companyRes, asset] = await Promise.all([
    getCompanyDetail(companyId),
    getAsset(companyId, assetId),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  if (!asset) notFound();
  const manage = canWriteCompany(me, company.id);

  const createdBy = asset.createdByUser;
  const updatedBy = asset.updatedByUser;

  const primaryField = asset.fields.find((f) => f.isPrimary);
  const noteFields = asset.fields.filter(
    (f) => f.fieldType === 'RICH_TEXT' || f.fieldType === 'TEXTAREA',
  );
  const noteFieldSlugs = new Set(noteFields.map((f) => f.slug));

  return (
    <>
      <AssetChatContext asset={asset} />
      <PageHeader
        crumbs={companyCrumbs(
          term,
          company,
          { label: 'Assets', href: `/admin/companies/${companyId}/assets` },
          {
            label: asset.layoutName,
            href: `/admin/companies/${companyId}/layouts/${asset.layoutSlug}`,
            mono: true,
          },
          { label: asset.name },
        )}
        title={asset.name}
        description={`${asset.layoutName} · created ${new Date(asset.createdAt).toLocaleDateString()}`}
        actions={
          manage ? (
            <AssetActions asset={asset} />
          ) : null
        }
      />
      <PageBody>
        <div
          className="detail-grid-main-aside"
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) 320px',
            gap: 16,
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Panel>
              <div
                style={{
                  display: 'flex',
                  gap: 14,
                  alignItems: 'flex-start',
                }}
              >
                <LayoutSwatch
                  icon={asset.layoutIcon}
                  color={asset.layoutColor}
                  size={44}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      flexWrap: 'wrap',
                    }}
                  >
                    <Tag tone="info" dot>
                      {asset.layoutName}
                    </Tag>
                    {asset.archivedAt && <Tag tone="warn">archived</Tag>}
                  </div>
                  <h2
                    style={{
                      fontSize: 22,
                      fontWeight: 550,
                      margin: '6px 0 3px',
                      letterSpacing: -0.3,
                    }}
                  >
                    {asset.name}
                  </h2>
                  <div
                    style={{
                      fontSize: 12,
                      color: 'var(--muted)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    updated {relative(new Date(asset.updatedAt))}
                    {updatedBy ? ` · by ${updatedBy.name}` : ''}
                  </div>
                </div>
              </div>

              <div
                style={{
                  marginTop: 20,
                  display: 'grid',
                  gridTemplateColumns: '140px minmax(0, 1fr)',
                  gap: '10px 20px',
                }}
              >
                {asset.fields
                  .filter((f) => !noteFieldSlugs.has(f.slug))
                  .map((f) => (
                    <Fragment key={f.id}>
                      <div
                        style={{
                          fontSize: 11.5,
                          color: 'var(--muted)',
                          fontFamily: 'var(--font-mono)',
                          textTransform: 'uppercase',
                          letterSpacing: 0.3,
                          paddingTop: 2,
                        }}
                      >
                        {f.name}
                        {primaryField?.id === f.id && (
                          <Tag tone="accent" style={{ marginLeft: 6 }}>
                            primary
                          </Tag>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          color: 'var(--text)',
                          minWidth: 0,
                          overflowWrap: 'anywhere',
                          wordBreak: 'break-word',
                        }}
                      >
                        {renderValue(
                          f,
                          asset.fieldValues[f.slug],
                          asset.references,
                          companyId,
                        )}
                      </div>
                    </Fragment>
                  ))}
              </div>
            </Panel>

            {noteFields.map((noteField) => {
              const value = asset.fieldValues[noteField.slug];
              if (!value) return null;
              return (
                <Panel key={noteField.id} title={noteField.name}>
                  {noteField.fieldType === 'RICH_TEXT' ? (
                    <RichTextView value={value} />
                  ) : (
                    <div
                      style={{
                        fontSize: 13.5,
                        lineHeight: 1.6,
                        color: 'var(--text-2)',
                        whiteSpace: 'pre-wrap',
                        overflowWrap: 'anywhere',
                        wordBreak: 'break-word',
                      }}
                    >
                      {String(value ?? '')}
                    </div>
                  )}
                </Panel>
              );
            })}
          </div>

          <aside style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <LinkedItemsPanel
              companyId={companyId}
              entityType="asset"
              entityId={asset.id}
              editable={manage && !asset.archivedAt}
            />

            <CredentialsPanel
              companyId={companyId}
              assetId={asset.id}
              mode="admin"
            />

            <AttachmentsPanel
              companyId={companyId}
              entityType="asset"
              entityId={asset.id}
              editable={manage && !asset.archivedAt}
            />

            <Panel title="Last activity">
              {(() => {
                const rows: React.ReactNode[] = [];
                rows.push(
                  <Row
                    key="created"
                    label="Created"
                    value={new Date(asset.createdAt).toLocaleString()}
                  />,
                );
                if (createdBy) {
                  rows.push(
                    <Row
                      key="created-by"
                      label="Created by"
                      value={createdBy.name}
                    />,
                  );
                }
                rows.push(
                  <Row
                    key="updated"
                    label="Updated"
                    value={new Date(asset.updatedAt).toLocaleString()}
                  />,
                );
                if (updatedBy) {
                  rows.push(
                    <Row
                      key="updated-by"
                      label="Updated by"
                      value={updatedBy.name}
                    />,
                  );
                }
                for (const src of asset.syncSources) {
                  rows.push(
                    <Row
                      key={`sync-${src.integrationId}-${src.resourceKey}-${src.externalId}`}
                      label={`Synced · ${src.driver.toLowerCase()}`}
                      value={relative(new Date(src.lastSyncedAt))}
                      title={`${src.resourceKey} · external id ${src.externalId} · last synced ${new Date(src.lastSyncedAt).toLocaleString()}`}
                    />,
                  );
                }
                if (asset.archivedAt) {
                  rows.push(
                    <Row
                      key="archived"
                      label="Archived"
                      value={new Date(asset.archivedAt).toLocaleString()}
                    />,
                  );
                }
                // Strip the bottom border from the final row.
                return rows.map((node, i) =>
                  i === rows.length - 1 && React.isValidElement(node)
                    ? React.cloneElement(
                        node as React.ReactElement<RowProps>,
                        { last: true },
                      )
                    : node,
                );
              })()}
            </Panel>

            <Link
              href={`/admin/companies/${companyId}/assets`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11.5,
                color: 'var(--muted)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <Icon.chevron size={10} style={{ transform: 'rotate(180deg)' }} />
              back to list
            </Link>
          </aside>
        </div>
      </PageBody>
    </>
  );
}

interface RowProps {
  label: string;
  value: string;
  last?: boolean;
  title?: string;
}

function Row({ label, value, last, title }: RowProps) {
  return (
    <div
      title={title}
      style={{
        display: 'flex',
        gap: 8,
        padding: '6px 0',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        fontSize: 12,
      }}
    >
      <span
        style={{
          flex: 1,
          minWidth: 0,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontSize: 10.5,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: 'var(--text-2)',
          textAlign: 'right',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {value}
      </span>
    </div>
  );
}

function renderValue(
  field: AssetSummary['fields'][number],
  value: unknown,
  references: AssetSummary['references'],
  companyId: string,
): React.ReactNode {
  if (value === null || value === undefined || value === '') {
    return <span style={{ color: 'var(--dim)' }}>—</span>;
  }
  switch (field.fieldType) {
    case 'BOOLEAN':
      return (
        <Tag tone={value ? 'ok' : 'outline'} dot>
          {value ? 'true' : 'false'}
        </Tag>
      );
    case 'DROPDOWN': {
      const choices = ((field.options as { choices?: Array<{ slug: string; label: string }> })
        .choices ?? []) as Array<{ slug: string; label: string }>;
      const match = choices.find((c) => c.slug === value);
      return match?.label ?? String(value);
    }
    case 'MULTISELECT': {
      if (!Array.isArray(value)) return String(value);
      const choices = ((field.options as { choices?: Array<{ slug: string; label: string }> })
        .choices ?? []) as Array<{ slug: string; label: string }>;
      const byName = new Map(choices.map((c) => [c.slug, c.label]));
      return (
        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {value.map((v) => (
            <Tag key={String(v)} tone="outline">
              {byName.get(String(v)) ?? String(v)}
            </Tag>
          ))}
        </span>
      );
    }
    case 'TAGS': {
      // Server-side `hydrateTagFields` converts the stored UUID array into
      // `{ id, name }` snapshots so we render the canonical display name
      // even after a rename. Legacy string entries (pre-migration data
      // that never got resolved) round-trip through `String(v)` as a
      // fallback so the chip still shows something meaningful.
      if (!Array.isArray(value)) return String(value);
      const chips = (value as unknown[])
        .map((v) => {
          if (
            v &&
            typeof v === 'object' &&
            typeof (v as { name?: unknown }).name === 'string'
          ) {
            const obj = v as { id?: string; name: string };
            return { key: obj.id ?? obj.name, label: obj.name };
          }
          if (typeof v === 'string' && v.length > 0) {
            return { key: v, label: v };
          }
          return null;
        })
        .filter((x): x is { key: string; label: string } => x !== null);
      if (chips.length === 0) return null;
      return (
        <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {chips.map((c) => (
            <Tag key={c.key} tone="outline">
              {c.label}
            </Tag>
          ))}
        </span>
      );
    }
    case 'URL':
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noreferrer"
          style={{
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {String(value)}
          <Icon.ext size={11} />
        </a>
      );
    case 'VAULTWARDEN_LINK': {
      const href = vaultLinkUrl(value);
      const label = vaultLinkLabel(value);
      if (!href) return <span style={{ color: 'var(--dim)' }}>—</span>;
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          style={{
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          {label}
          <Icon.ext size={11} />
        </a>
      );
    }
    case 'EMAIL':
      return (
        <a
          href={`mailto:${value}`}
          style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}
        >
          {String(value)}
        </a>
      );
    case 'IP_ADDRESS':
      return (
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12.5,
            color: 'var(--text)',
          }}
        >
          {String(value)}
        </span>
      );
    case 'ASSET_REFERENCE': {
      const ids = Array.isArray(value) ? value : [value];
      return (
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {ids.map((v) => {
            const id = String(v);
            const hit = references[id];
            if (!hit) {
              return (
                <span
                  key={id}
                  title="Referenced asset is no longer available"
                  style={{ display: 'inline-flex' }}
                >
                  <Tag tone="outline">{id.slice(0, 8)}… (missing)</Tag>
                </span>
              );
            }
            return (
              <Link
                key={id}
                href={`/admin/companies/${companyId}/assets/${id}`}
                style={{ textDecoration: 'none' }}
              >
                <Tag
                  tone="info"
                  dot
                  style={
                    hit.archivedAt
                      ? { textDecoration: 'line-through', opacity: 0.75 }
                      : undefined
                  }
                >
                  {hit.name}
                </Tag>
              </Link>
            );
          })}
        </span>
      );
    }
    case 'DATE':
    case 'DATETIME': {
      const raw = typeof value === 'string' ? value : String(value);
      const formatted = formatDateField(raw, field.fieldType);
      return (
        <span
          style={{
            fontSize: 12.5,
          }}
          title={raw}
        >
          {formatted ?? raw}
        </span>
      );
    }
    case 'RICH_TEXT':
      return <RichTextView value={value} />;
    case 'FILE': {
      const entries = Array.isArray(value) ? (value as FileFieldValue[]) : [];
      if (entries.length === 0) return <span style={{ color: 'var(--dim)' }}>—</span>;
      return <FileTileRow entries={entries} />;
    }
    default:
      return <span>{String(value)}</span>;
  }
}

type FileFieldValue = {
  uploadId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  isImage?: boolean;
  thumbnailUrl?: string | null;
  downloadUrl?: string | null;
};

function FileTileRow({ entries }: { entries: FileFieldValue[] }) {
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

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function relative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return 'just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return d.toLocaleDateString();
}

function formatDateField(
  raw: string,
  fieldType: 'DATE' | 'DATETIME',
): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (fieldType === 'DATE') {
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
