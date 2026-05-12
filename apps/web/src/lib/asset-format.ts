import { tiptapDocToMarkdown } from './article-format';
import type { AssetSummary } from './server-api';

/**
 * Project an `AssetSummary` (as returned by `GET
 * /companies/:companyId/assets/:assetId`) to a markdown blob suitable
 * for inlining in the chat system prompt. Mirrors the field-type
 * rendering on the asset detail page ([page.tsx](apps/web/src/app/admin/companies/[id]/assets/[assetId]/page.tsx)
 * `renderValue`) but emits plain markdown instead of React nodes.
 *
 * Non-empty fields only. The server already strips fields by role
 * before returning the row, so client portal users transparently get
 * a filtered subset and we don't need any extra visibility logic
 * here.
 *
 * `VAULTWARDEN_LINK` is intentionally skipped — credential pointers
 * are not useful (and potentially sensitive) to forward to the LLM.
 */
export function assetToMarkdown(asset: AssetSummary): {
  markdown: string;
  layoutName: string;
} {
  const lines: string[] = [];
  lines.push(`**Layout:** ${asset.layoutName}`);

  // `asset.fields` is already returned sorted by layout position
  // (see `serializeAsset` in apps/api/src/assets/assets.service.ts).
  // Walk it in that order so the markdown matches the detail page's
  // visual ordering and the LLM sees primary / identifying fields
  // first.
  for (const field of asset.fields) {
    if (field.fieldType === 'VAULTWARDEN_LINK') continue;
    const raw = asset.fieldValues[field.slug];
    if (isEmpty(raw)) continue;
    const rendered = renderField(field, raw, asset.references);
    if (rendered === null || rendered === '') continue;
    lines.push(`- **${field.name}**: ${rendered}`);
  }
  return { markdown: lines.join('\n'), layoutName: asset.layoutName };
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

type FieldMeta = AssetSummary['fields'][number];

function renderField(
  field: FieldMeta,
  value: unknown,
  references: AssetSummary['references'],
): string | null {
  switch (field.fieldType) {
    case 'TEXT':
    case 'TEXTAREA':
    case 'NUMBER':
    case 'EMAIL':
    case 'PHONE':
    case 'IP_ADDRESS':
    case 'URL':
      return String(value);
    case 'BOOLEAN':
      return value ? 'true' : 'false';
    case 'DATE':
    case 'DATETIME':
      // ISO 8601 as stored — gives the LLM an unambiguous timestamp
      // without locale-dependent formatting.
      return String(value);
    case 'DROPDOWN': {
      const choices = readChoices(field);
      const match = choices.find((c) => c.slug === String(value));
      return match?.label ?? String(value);
    }
    case 'MULTISELECT': {
      if (!Array.isArray(value)) return String(value);
      const choices = readChoices(field);
      const byName = new Map(choices.map((c) => [c.slug, c.label]));
      const labels = value
        .map((v) => byName.get(String(v)) ?? String(v))
        .filter((s) => s.length > 0);
      return labels.length > 0 ? labels.join(', ') : null;
    }
    case 'TAGS': {
      if (!Array.isArray(value)) return String(value);
      const names = (value as unknown[])
        .map((v) => {
          if (
            v &&
            typeof v === 'object' &&
            typeof (v as { name?: unknown }).name === 'string'
          ) {
            return (v as { name: string }).name;
          }
          if (typeof v === 'string' && v.length > 0) return v;
          return null;
        })
        .filter((s): s is string => s !== null);
      return names.length > 0 ? names.join(', ') : null;
    }
    case 'ASSET_REFERENCE': {
      const ids = Array.isArray(value) ? value : [value];
      const names = ids
        .map((v) => {
          const id = String(v);
          const hit = references[id];
          // Fall back to a truncated id if the referent was hard-
          // deleted or is out of scope — same convention as the
          // detail page's "missing" badge.
          return hit ? hit.name : `${id.slice(0, 8)}… (missing)`;
        })
        .filter((s) => s.length > 0);
      return names.length > 0 ? names.join(', ') : null;
    }
    case 'RICH_TEXT': {
      try {
        const md = tiptapDocToMarkdown(value);
        return md.trim().length > 0 ? md.trim() : null;
      } catch {
        return null;
      }
    }
    case 'FILE': {
      if (!Array.isArray(value)) return null;
      const names = (value as Array<{ filename?: unknown }>)
        .map((e) =>
          typeof e?.filename === 'string' && e.filename.length > 0
            ? e.filename
            : null,
        )
        .filter((s): s is string => s !== null);
      return names.length > 0 ? names.join(', ') : null;
    }
    case 'VAULTWARDEN_LINK':
      return null;
    default:
      return String(value);
  }
}

function readChoices(field: FieldMeta): Array<{ slug: string; label: string }> {
  const raw = (field.options as { choices?: unknown }).choices;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is { slug: string; label: string } =>
      !!c &&
      typeof c === 'object' &&
      typeof (c as { slug?: unknown }).slug === 'string' &&
      typeof (c as { label?: unknown }).label === 'string',
  );
}
