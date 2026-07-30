import type { ReactNode } from 'react';
import {
  formatCalendarDate,
  formatDateTime,
  safeExternalHref,
} from '@weavestream/shared';
import { FileTile, FileTileGrid } from '../../components/FileTile';
import { Icon } from '../../components/Icon';
import { Card } from '../../components/primitives';
import { TiptapView } from '../../components/richtext/TiptapView';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { deviceTimeZone } from '../../lib/timezone';
import type { AssetFieldMeta, AssetRecord } from './api';
import { choiceLabel } from './card-fields';
import { isKnownFieldType } from './field-values';

/**
 * The detail screen's field rendering — every field on the layout, in
 * `position` order, no tiering, no cap, no disclosure (build plan:
 * customer-defined content is shown in full; which of their own fields
 * matter onsite is not ours to decide). `asset.fields` arrives
 * pre-sorted by position and pre-filtered per role, so it renders
 * directly with no layouts join.
 *
 * Every label is shown even when the value is empty (`—`) — a field
 * silently absent is how a technician comes to believe a record is
 * complete. Unknown field types render their raw value read-only: the
 * enum will grow, and one unhandled case must not take out an asset
 * detail screen in a server closet.
 */
export function AssetFieldRows({ asset }: { asset: AssetRecord }) {
  if (asset.fields.length === 0) return null;
  return (
    <Card className="flex flex-col divide-y divide-line px-4">
      {asset.fields.map((field) => (
        <div key={field.id} className="flex flex-col gap-1.5 py-3">
          <span className="font-mono text-section uppercase tracking-[0.1em] text-muted">
            {field.name}
          </span>
          <AssetFieldValue
            field={field}
            value={asset.fieldValues[field.slug]}
            references={asset.references}
          />
        </div>
      ))}
    </Card>
  );
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

function Empty() {
  return <span className="text-body text-dim">—</span>;
}

export function AssetFieldValue({
  field,
  value,
  references,
}: {
  field: AssetFieldMeta;
  value: unknown;
  references: AssetRecord['references'];
}) {
  if (isEmptyValue(value)) return <Empty />;

  if (!isKnownFieldType(field.fieldType)) return <UnknownValue value={value} />;

  switch (field.fieldType) {
    case 'TEXT':
      return <BodyText>{String(value)}</BodyText>;
    case 'TEXTAREA':
      return (
        <p className="whitespace-pre-wrap break-words text-body leading-relaxed text-text">
          {String(value)}
        </p>
      );
    case 'NUMBER':
      return <BodyText>{String(value)}</BodyText>;
    case 'BOOLEAN':
      return <BodyText>{value === true ? 'Yes' : 'No'}</BodyText>;
    case 'DATE':
      return <BodyText>{formatCalendarDate(String(value))}</BodyText>;
    case 'DATETIME':
      return <BodyText>{formatDateTime(String(value), deviceTimeZone())}</BodyText>;
    case 'EMAIL':
      return (
        <a
          href={`mailto:${String(value)}`}
          className="break-all font-mono text-[15px] text-accent-text underline-offset-2"
        >
          {String(value)}
        </a>
      );
    case 'PHONE':
      // Deliberate mobile improvement over desktop: values are
      // server-canonical E.164, so tel: is always well-formed.
      return (
        <a
          href={`tel:${String(value)}`}
          className="break-all font-mono text-[15px] text-accent-text underline-offset-2"
        >
          {String(value)}
        </a>
      );
    case 'IP_ADDRESS':
      return <span className="break-all font-mono text-[15px] text-text">{String(value)}</span>;
    case 'URL':
      return <ExternalLinkValue url={String(value)} label={String(value)} />;
    case 'VAULTWARDEN_LINK':
      return <VaultLinkValue value={value} />;
    case 'DROPDOWN':
      return <BodyText>{choiceLabel(field.options, String(value)) ?? String(value)}</BodyText>;
    case 'MULTISELECT': {
      const items = Array.isArray(value)
        ? value
            .filter((v): v is string => typeof v === 'string')
            .map((slug) => choiceLabel(field.options, slug) ?? slug)
        : [];
      return items.length > 0 ? <PillList items={items} /> : <Empty />;
    }
    case 'TAGS': {
      const names = Array.isArray(value)
        ? value.flatMap((v) => {
            if (typeof v === 'string') return [v];
            if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
              return [(v as { name: string }).name];
            }
            return [];
          })
        : [];
      return names.length > 0 ? <PillList items={names} /> : <Empty />;
    }
    case 'ASSET_REFERENCE':
      return <ReferenceValue value={value} references={references} />;
    case 'RICH_TEXT':
      return <TiptapView doc={value} />;
    case 'FILE':
      return <FileValue value={value} />;
    default:
      return <UnknownValue value={value} />;
  }
}

function BodyText({ children }: { children: ReactNode }) {
  return <span className="break-words text-body text-text">{children}</span>;
}

/**
 * `safeExternalHref` or plain text — never a raw href. Legacy and
 * integration-written rows are not guaranteed to satisfy the server's
 * current https regex (same stance as the passwords UrlRow).
 */
function ExternalLinkValue({ url, label }: { url: string; label: string }) {
  const href = safeExternalHref(url);
  if (!href) {
    return <span className="break-all text-body text-text">{label}</span>;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex max-w-full items-center gap-1.5 break-all text-body text-accent-text"
    >
      <span className="min-w-0 break-all">{label}</span>
      <Icon name="open_in_new" size={16} className="shrink-0" />
    </a>
  );
}

/** Legacy read-only type: `{url, label?}` object or a bare string. */
function VaultLinkValue({ value }: { value: unknown }) {
  let url = '';
  let label = '';
  if (typeof value === 'string') {
    url = value;
    label = value;
  } else if (value && typeof value === 'object') {
    const obj = value as { url?: unknown; label?: unknown };
    url = typeof obj.url === 'string' ? obj.url : '';
    label =
      typeof obj.label === 'string' && obj.label.trim() !== ''
        ? obj.label
        : url;
  }
  if (url === '') return <Empty />;
  return <ExternalLinkValue url={url} label={label} />;
}

function PillList({ items }: { items: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.75">
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          className="rounded-chip bg-panel-2 px-2.25 py-1 text-[13px] font-medium text-text-2"
        >
          {item}
        </span>
      ))}
    </span>
  );
}

function ReferenceValue({
  value,
  references,
}: {
  value: unknown;
  references: AssetRecord['references'];
}) {
  const navigate = useScopedNavigate();
  const ids = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return <Empty />;
  return (
    <span className="flex flex-col">
      {ids.map((id) => {
        const entry = references[id];
        if (!entry) {
          // Deleted or cross-tenant: keep the breakage visible instead
          // of hiding the id (desktop convention).
          return (
            <span key={id} className="py-1 font-mono text-[13px] text-muted">
              {id.slice(0, 8)}… (missing)
            </span>
          );
        }
        const archived = entry.archivedAt !== null;
        return (
          <button
            key={id}
            type="button"
            onClick={() => navigate({ to: `/assets/${id}` })}
            className="flex min-h-tap items-center gap-2 text-left active:bg-panel-2"
          >
            <span
              className={
                'min-w-0 flex-1 truncate text-body font-medium ' +
                (archived ? 'text-muted line-through' : 'text-accent-text')
              }
            >
              {entry.name}
            </span>
            {archived && (
              <span className="shrink-0 text-[12px] text-muted">archived</span>
            )}
            <Icon name="chevron_right" size={18} className="shrink-0 text-faint" />
          </button>
        );
      })}
    </span>
  );
}

function FileValue({ value }: { value: unknown }) {
  if (!Array.isArray(value) || value.length === 0) return <Empty />;
  return (
    <FileTileGrid>
      {value.flatMap((raw, i) => {
        if (!raw || typeof raw !== 'object') return [];
        const obj = raw as Record<string, unknown>;
        const filename = typeof obj['filename'] === 'string' ? obj['filename'] : null;
        if (!filename) return [];
        const mime = typeof obj['mimeType'] === 'string' ? obj['mimeType'] : '';
        return [
          <FileTile
            key={typeof obj['uploadId'] === 'string' ? obj['uploadId'] : `${filename}-${i}`}
            filename={filename}
            sizeBytes={
              typeof obj['sizeBytes'] === 'number' && Number.isFinite(obj['sizeBytes'])
                ? obj['sizeBytes']
                : 0
            }
            isImage={
              typeof obj['isImage'] === 'boolean'
                ? obj['isImage']
                : mime.startsWith('image/')
            }
            thumbnailUrl={typeof obj['thumbnailUrl'] === 'string' ? obj['thumbnailUrl'] : null}
            href={typeof obj['downloadUrl'] === 'string' ? obj['downloadUrl'] : null}
          />,
        ];
      })}
    </FileTileGrid>
  );
}

/** Raw read-only fallback — must render something, never crash. */
function UnknownValue({ value }: { value: unknown }) {
  const text =
    typeof value === 'object' ? JSON.stringify(value) : String(value);
  return (
    <span className="break-all font-mono text-[13px] text-muted">{text}</span>
  );
}
