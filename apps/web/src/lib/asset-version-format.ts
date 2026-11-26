import type { AssetVersionFieldMeta } from '@weavestream/shared';

/** Longest text shown for one captured value before it is cut with an ellipsis. */
export const VERSION_VALUE_MAX_CHARS = 400;

function clip(text: string): string {
  return text.length > VERSION_VALUE_MAX_CHARS
    ? `${text.slice(0, VERSION_VALUE_MAX_CHARS)}…`
    : text;
}

/** Text content of a ProseMirror document (RICH_TEXT values), no markup. */
function richTextToPlain(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const n = node as { text?: unknown; content?: unknown };
  if (typeof n.text === 'string') return n.text;
  if (!Array.isArray(n.content)) return '';
  return n.content.map(richTextToPlain).filter(Boolean).join(' ');
}

type Choice = { slug: string; label?: string };

function labelFor(field: Pick<AssetVersionFieldMeta, 'options'>, slug: string): string {
  const list = (field.options as { choices?: Choice[] }).choices ?? [];
  return list.find((c) => c.slug === slug)?.label ?? slug;
}

/**
 * Plain text for one captured value, or `null` when the field was empty.
 * Never throws and never renders markup: the result is shown as a React
 * text node. Types whose stored form is an opaque id (TAGS, ASSET_REFERENCE)
 * show a count, because the panel has no lookup for the ids.
 */
export function formatVersionValue(
  field: Pick<AssetVersionFieldMeta, 'fieldType' | 'options'>,
  value: unknown,
): string | null {
  if (value === null || value === undefined || value === '') return null;
  switch (field.fieldType) {
    case 'BOOLEAN':
      return value ? 'Yes' : 'No';
    case 'DROPDOWN':
      return clip(labelFor(field, String(value)));
    case 'MULTISELECT':
      return Array.isArray(value) && value.length > 0
        ? clip(value.map((v) => labelFor(field, String(v))).join(', '))
        : null;
    case 'TAGS':
      return Array.isArray(value) && value.length > 0
        ? `${value.length} tag${value.length === 1 ? '' : 's'}`
        : null;
    case 'ASSET_REFERENCE': {
      const n = Array.isArray(value) ? value.length : 1;
      return `${n} linked asset${n === 1 ? '' : 's'}`;
    }
    case 'FILE': {
      const names = (Array.isArray(value) ? value : [])
        .map((e) =>
          e && typeof e === 'object' && typeof (e as { filename?: unknown }).filename === 'string'
            ? (e as { filename: string }).filename
            : '',
        )
        .filter(Boolean);
      return names.length > 0 ? clip(names.join(', ')) : null;
    }
    case 'RICH_TEXT': {
      const plain = richTextToPlain(value).trim();
      return plain ? clip(plain) : null;
    }
    case 'VAULTWARDEN_LINK': {
      if (value && typeof value === 'object') {
        const v = value as { label?: unknown; url?: unknown };
        const text = typeof v.label === 'string' && v.label ? v.label : v.url;
        return typeof text === 'string' && text ? clip(text) : null;
      }
      return clip(String(value));
    }
    default:
      if (typeof value === 'string') return clip(value);
      if (typeof value === 'number') return String(value);
      if (Array.isArray(value)) return value.length > 0 ? clip(value.join(', ')) : null;
      return clip(JSON.stringify(value));
  }
}
