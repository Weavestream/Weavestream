import {
  CUSTOM_API_LIMITS,
  CUSTOM_API_RESOURCE_KEYS,
  customApiDefinitionSchema,
  isValidHttpUrl,
  parsePath,
  readPath,
  type CustomApiField,
  type CustomApiResource,
  type CustomApiResourceKey,
  type IntegrationSectionGroup,
  type SourceFieldDto,
} from '@weavestream/shared';
import type { LegacyDriverRecord } from '../integration-driver.js';
import { bool, clean, date, datetime, group, num, text, toIso, type Row } from '../section-rows.js';
import { ITEMS_MATCH_FIELD } from './custom-api.resources.js';

/**
 * Turning untrusted upstream records into driver records. Only single
 * values are read (an object or a list at a path counts as missing),
 * strings are capped at the detail-card text limit, and the section is
 * plain data that the runner validates with integrationSectionSchema.
 */

/** Title of the detail card. */
export const SECTION_TITLE = 'Custom API';

type Scalar = string | number | boolean;

export interface ParsedRecord {
  externalId: string;
  name: string;
  match: string | null;
  orgId: string | null;
  orgName: string | null;
  extras: Array<{ field: CustomApiField; value: Scalar | null }>;
}

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const HAS_CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** A synced string: no control characters, capped. */
export function capText(value: string): string {
  return value.replace(CONTROL_RE, '').slice(0, CUSTOM_API_LIMITS.stringValue);
}

function scalarAt(item: unknown, path: string): Scalar | null {
  const read = readPath(item, parsePath(path));
  return read.kind === 'value' ? read.value : null;
}

function textAt(item: unknown, path: string | undefined): string | null {
  if (!path) return null;
  const value = scalarAt(item, path);
  if (value === null) return null;
  const out = capText(String(value)).trim();
  return out === '' ? null : out;
}

/** An id: a non-empty string or an integer. */
export function idAt(item: unknown, path: string): string | null {
  const value = scalarAt(item, path);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed !== '' && trimmed.length <= 512 && !HAS_CONTROL_RE.test(trimmed) ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function typedValue(field: CustomApiField, raw: Scalar | null): Scalar | null {
  if (raw === null) return null;
  switch (field.type) {
    case 'NUMBER': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'BOOLEAN':
      if (typeof raw === 'boolean') return raw;
      if (raw === 1 || raw === 0) return raw === 1;
      if (typeof raw === 'string' && /^(true|false)$/i.test(raw.trim())) return raw.trim().toLowerCase() === 'true';
      return null;
    case 'DATE': {
      const iso = toIso(typeof raw === 'boolean' ? null : raw);
      return iso ? iso.slice(0, 10) : null;
    }
    case 'DATETIME':
      return toIso(typeof raw === 'boolean' ? null : raw);
    default: {
      const out = capText(String(raw)).trim();
      return out === '' ? null : out;
    }
  }
}

/** One upstream record, or null when it has no usable id. */
export function parseRecord(item: unknown, resource: CustomApiResource): ParsedRecord | null {
  const externalId = idAt(item, resource.idPath);
  if (externalId === null) return null;
  return {
    externalId,
    name: textAt(item, resource.namePath) ?? externalId,
    match: textAt(item, resource.matchPath),
    orgId: resource.orgIdPath ? idAt(item, resource.orgIdPath) : null,
    orgName: textAt(item, resource.orgNamePath),
    extras: resource.fields.map((field) => ({ field, value: typedValue(field, scalarAt(item, field.path)) })),
  };
}

function extraRow(field: CustomApiField, value: Scalar | null): Row {
  const label = clean(field.label, 120);
  if (value === null) return null;
  switch (field.type) {
    case 'NUMBER':
      return num(label, typeof value === 'number' ? value : null);
    case 'BOOLEAN':
      return bool(label, typeof value === 'boolean' ? value : null);
    case 'DATE':
      return date(label, typeof value === 'string' ? value : null);
    case 'DATETIME':
      return datetime(label, typeof value === 'string' ? value : null);
    case 'URL':
      return typeof value === 'string' && value.length <= 2_048 && isValidHttpUrl(value)
        ? { kind: 'link', label, value }
        : text(label, String(value));
    default:
      return text(label, String(value));
  }
}

const ROWS_PER_GROUP = 40;

/** The detail card: the fields, in definition order. Undefined when nothing has a value. */
export function buildSection(record: ParsedRecord): unknown {
  const groups: IntegrationSectionGroup[] = [];
  const rows = record.extras.map(({ field, value }) => extraRow(field, value)).filter((row) => row !== null);
  for (let start = 0; start < rows.length; start += ROWS_PER_GROUP) {
    groups.push(group(start === 0 ? 'details' : `details-${start / ROWS_PER_GROUP + 1}`, start === 0 ? 'Details' : 'More details', undefined, rows.slice(start, start + ROWS_PER_GROUP)));
  }
  return groups.length > 0 ? { title: SECTION_TITLE, groups } : undefined;
}

/** The driver record of a parsed upstream record: the name, the match key (when set) and every field. */
export function toDriverRecord(resource: CustomApiResource, record: ParsedRecord): LegacyDriverRecord {
  const fields: Record<string, unknown> = { name: record.name };
  if (resource.matchPath) fields[ITEMS_MATCH_FIELD] = record.match;
  for (const { field, value } of record.extras) fields[field.key] = value;
  const section = buildSection(record);
  return {
    externalId: record.externalId,
    displayName: record.name,
    fields,
    ...(section ? { section } : {}),
    updatedAt: null,
  };
}

/**
 * The "Open in" link of a synced record: the resource's `recordUrl` with
 * the URL-encoded source id for `{id}`. HTTPS only; any host (the web app
 * is often not on the API host). Undefined when the definition has no
 * link or the result is not a safe URL.
 */
export function customApiRecordUrl(sourceId: string, ctx: { resourceKey: string; config: unknown }): string | undefined {
  if (!(CUSTOM_API_RESOURCE_KEYS as readonly string[]).includes(ctx.resourceKey)) return undefined;
  const parsed = customApiDefinitionSchema.safeParse(ctx.config);
  if (!parsed.success) return undefined;
  const resource = parsed.data.resources[ctx.resourceKey as CustomApiResourceKey];
  if (!resource.enabled || !resource.recordUrl) return undefined;
  try {
    const url = new URL(resource.recordUrl.replaceAll('{id}', encodeURIComponent(sourceId)));
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    // Not a URL after the id went in: no link.
    return undefined;
  }
}

/**
 * Source fields offered on the field mappings tab: the name, the match
 * key (when set) and every field, typed by its declared type.
 */
export function sourceFields(resource: CustomApiResource | null): SourceFieldDto[] {
  const fields: SourceFieldDto[] = [{ key: 'name', label: 'Name', hintType: 'TEXT', alwaysPresent: true }];
  if (resource?.matchPath) fields.push({ key: ITEMS_MATCH_FIELD, label: 'Match key', hintType: 'TEXT', alwaysPresent: false });
  for (const field of resource?.fields ?? []) {
    fields.push({ key: field.key, label: field.label, hintType: field.type, alwaysPresent: false });
  }
  return fields;
}
