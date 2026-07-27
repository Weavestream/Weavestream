import { formatCalendarDate, formatDate } from '@weavestream/shared';
import type { AssetRecord, LayoutRecord } from './api';

/**
 * List-card meta projection.
 *
 * The card is title plus ONE meta line, never a third (build plan).
 * The line is built from the `isPrimary || showInTable` fields in
 * layout `position` order — the same job `showInTable` does on the
 * desktop per-layout table. That data lives only on `GET /layouts`,
 * so the projection takes the joined layout; when it hasn't resolved
 * (still loading, or the layout was archived), it degrades to the
 * primary field from the asset row's own embedded `fields[]` instead
 * of blanking the meta line.
 */

interface CompactField {
  fieldType: string;
  name: string;
  options: Record<string, unknown>;
  slug: string;
}

const CARD_PART_CAP = 4;

export function cardMetaParts(
  asset: AssetRecord,
  layout: LayoutRecord | undefined,
  tz: string,
): string[] {
  const candidates: CompactField[] = layout
    ? layout.fields.filter(
        (f) => (f.isPrimary || f.showInTable) && f.archivedAt === null,
      )
    : asset.fields.filter((f) => f.isPrimary);

  const parts: string[] = [];
  for (const field of candidates) {
    if (parts.length >= CARD_PART_CAP) break;
    // Slug absent from fieldValues = empty, or filtered by role
    // visibility server-side — either way there is nothing to show.
    const value = asset.fieldValues[field.slug];
    const part = formatCompactValue(field, value, asset.references, tz);
    if (part === null) continue;
    // The primary field usually IS the source of the asset name —
    // without this dedupe every card's meta line starts by repeating
    // its own title.
    if (part === asset.name) continue;
    parts.push(part);
  }
  return parts;
}

/**
 * One-line scalar rendering of a field value for the card meta.
 * Returns null for empty values and for types with no usable one-line
 * form (RICH_TEXT, FILE — and VAULTWARDEN_LINK, a credential pointer
 * that has no business on a list card).
 */
export function formatCompactValue(
  field: CompactField,
  value: unknown,
  references: AssetRecord['references'],
  tz: string,
): string | null {
  if (value === null || value === undefined || value === '') return null;

  switch (field.fieldType) {
    case 'RICH_TEXT':
    case 'FILE':
    case 'VAULTWARDEN_LINK':
      return null;
    case 'BOOLEAN':
      // A bare "Yes" in an unlabeled meta line is meaningless; the field
      // name reads as a badge ("Monitored"). False adds nothing.
      return value === true ? field.name : null;
    case 'TEXTAREA': {
      const first = String(value).split('\n', 1)[0]?.trim();
      return first ? first : null;
    }
    case 'DATE':
      return nonEmpty(formatCalendarDate(String(value)));
    case 'DATETIME':
      return nonEmpty(formatDate(String(value), tz));
    case 'DROPDOWN': {
      const label = choiceLabel(field.options, String(value));
      return label ?? String(value);
    }
    case 'MULTISELECT': {
      if (!Array.isArray(value) || value.length === 0) return null;
      const labels = value
        .filter((v): v is string => typeof v === 'string')
        .map((slug) => choiceLabel(field.options, slug) ?? slug);
      return withOverflow(labels);
    }
    case 'TAGS': {
      if (!Array.isArray(value) || value.length === 0) return null;
      const names = value.flatMap((v) => {
        if (typeof v === 'string') return [v];
        if (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string') {
          return [(v as { name: string }).name];
        }
        return [];
      });
      return withOverflow(names);
    }
    case 'ASSET_REFERENCE': {
      if (!Array.isArray(value) || value.length === 0) return null;
      const names = value
        .filter((v): v is string => typeof v === 'string')
        .map((id) => references[id]?.name ?? `${id.slice(0, 8)}… (missing)`);
      return withOverflow(names);
    }
    default: {
      // TEXT / NUMBER / EMAIL / PHONE / IP_ADDRESS / URL — and any
      // future type: a String() is the honest fallback.
      if (Array.isArray(value)) return null;
      if (typeof value === 'object') return null;
      const s = String(value).trim();
      return s ? s : null;
    }
  }
}

/** First 2 entries + `+n` overflow, or null when nothing survived. */
function withOverflow(entries: string[]): string | null {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, 2).join(', ');
  return entries.length > 2 ? `${shown} +${entries.length - 2}` : shown;
}

/** DROPDOWN/MULTISELECT slug → configured label; null when unknown. */
export function choiceLabel(
  options: Record<string, unknown>,
  slug: string,
): string | null {
  const choices = options['choices'];
  if (!Array.isArray(choices)) return null;
  for (const c of choices) {
    if (
      c &&
      typeof c === 'object' &&
      (c as { slug?: unknown }).slug === slug &&
      typeof (c as { label?: unknown }).label === 'string'
    ) {
      return (c as { label: string }).label;
    }
  }
  return null;
}

/** The shared formatters render unparseable input as '—'; drop those. */
function nonEmpty(formatted: string): string | null {
  return formatted === '—' ? null : formatted;
}
