import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatCalendarDate, type AssetSummary } from '@weavestream/shared';
import { Tag } from '../ui';
import { RichTextView } from '../editor/rich-text-view';
import { vaultLinkLabel, vaultLinkUrl } from '../../lib/vault-link';
import { ExternalUrlValue } from './external-url-value';
import { FileTileRow, type FileFieldValue } from './file-tile-row';

/**
 * Routing context for a rendered field value. Required, with no admin
 * default, so a portal page can never emit an admin-scoped link by
 * omission.
 */
export interface AssetFieldContext {
  /**
   * Base path for ASSET_REFERENCE chips: `/admin/companies/<id>/assets`
   * or `/portal/<slug>/assets`. The referenced id is appended.
   */
  assetHrefBase: string;
  /** Mention routing for RICH_TEXT values; see `RichTextView`. */
  richText: {
    isAdmin: boolean;
    portalSlugByCompanyId?: Record<string, string>;
    fallbackCompanyId: string;
  };
}

type Choice = { slug: string; label: string };

/**
 * Renders one stored field value on the asset detail pages (admin +
 * portal). The surfaces differ only in `context`: where reference chips
 * link to and how rich-text mentions resolve.
 */
export function AssetFieldValue({
  field,
  value,
  references,
  context,
}: {
  field: AssetSummary['fields'][number];
  value: unknown;
  references: AssetSummary['references'];
  context: AssetFieldContext;
}): ReactNode {
  if (value === null || value === undefined || value === '') {
    return <Placeholder />;
  }
  switch (field.fieldType) {
    case 'BOOLEAN':
      return (
        <Tag tone={value ? 'ok' : 'outline'}>
          {value ? 'true' : 'false'}
        </Tag>
      );
    case 'DROPDOWN': {
      const match = fieldChoices(field).find((c) => c.slug === value);
      return match?.label ?? String(value);
    }
    case 'MULTISELECT': {
      if (!Array.isArray(value)) return String(value);
      const byName = new Map(fieldChoices(field).map((c) => [c.slug, c.label]));
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
      return <ExternalUrlValue url={String(value)} />;
    case 'VAULTWARDEN_LINK':
      return (
        <ExternalUrlValue
          url={vaultLinkUrl(value)}
          label={vaultLinkLabel(value) || undefined}
        />
      );
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
                href={`${context.assetHrefBase}/${encodeURIComponent(id)}`}
                style={{ textDecoration: 'none' }}
              >
                <Tag
                  tone="info"
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
        <span style={{ fontSize: 12.5 }} title={raw}>
          {formatted ?? raw}
        </span>
      );
    }
    case 'RICH_TEXT':
      return (
        <RichTextView
          value={value}
          isAdmin={context.richText.isAdmin}
          portalSlugByCompanyId={context.richText.portalSlugByCompanyId}
          fallbackCompanyId={context.richText.fallbackCompanyId}
        />
      );
    case 'FILE': {
      const entries = Array.isArray(value) ? (value as FileFieldValue[]) : [];
      if (entries.length === 0) return <Placeholder />;
      return <FileTileRow entries={entries} />;
    }
    default:
      return <span>{String(value)}</span>;
  }
}

function Placeholder() {
  return <span style={{ color: 'var(--dim)' }}>—</span>;
}

function fieldChoices(field: AssetSummary['fields'][number]): Choice[] {
  return (field.options as { choices?: Choice[] }).choices ?? [];
}

/**
 * Formatted DATE / DATETIME value, or null when unparseable (the caller
 * then shows the raw string). DATE is a stored calendar day, so it goes
 * through the shared UTC-pinned `formatCalendarDate` and never rolls back
 * a day west of UTC. DATETIME still formats in the server's zone.
 */
function formatDateField(
  raw: string,
  fieldType: 'DATE' | 'DATETIME',
): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  if (fieldType === 'DATE') return formatCalendarDate(raw);
  return new Date(ms).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
