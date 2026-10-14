import type { IntegrationSectionGroup, IntegrationSectionRow } from '@weavestream/shared';
import { PhoneStrategy } from '../../field-types/strategies/contact.strategy.js';

/**
 * Row builders shared by the drivers that emit integration sections
 * (integrationSectionSchema). Each returns null for a missing value, so a
 * group simply drops it; strings are cleaned to the plain text the schema
 * accepts.
 */

export type Row = IntegrationSectionRow | null;

/** A lookup that may be unavailable (missing permission, API off, too large); the reason is fixed text. */
export type Lookup<T> = { ok: true; value: T } | { ok: false; reason: string };

const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Plain text the section schema accepts: no controls, nothing tag-shaped, capped. */
export function clean(value: string, max: number): string {
  return value.replace(CONTROL_RE, '').replace(/<(?=[a-z!/?])/gi, '< ').slice(0, max);
}

export function text(label: string, value: string | null | undefined): Row {
  return value ? { kind: 'text', label, value: clean(value, 1_000) } : null;
}

export function num(label: string, value: number | null | undefined): Row {
  return typeof value === 'number' && Number.isFinite(value) ? { kind: 'number', label, value } : null;
}

export function bool(label: string, value: boolean | null | undefined): Row {
  return typeof value === 'boolean' ? { kind: 'boolean', label, value } : null;
}

export function badge(label: string, value: string, tone: 'neutral' | 'success' | 'warning' | 'danger'): Row {
  return { kind: 'badge', label, value: clean(value, 64), tone };
}

/** ISO string, or an epoch-milliseconds string, as an ISO datetime. */
export function toIso(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' || /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function datetime(label: string, value: string | number | null | undefined): Row {
  const iso = toIso(value);
  return iso ? { kind: 'datetime', label, value: iso } : null;
}

export function date(label: string, value: string | number | null | undefined): Row {
  const iso = toIso(value);
  return iso ? { kind: 'date', label, value: iso.slice(0, 10) } : null;
}

export function list(label: string, values: string[]): Row {
  return { kind: 'list', label, value: values.slice(0, 50).map((value) => clean(value, 200)) };
}


export function group(
  key: string,
  title: string,
  icon: IntegrationSectionGroup['icon'],
  rows: Row[],
): IntegrationSectionGroup {
  return { key, title, ...(icon ? { icon } : {}), rows: rows.filter((row): row is IntegrationSectionRow => row !== null).slice(0, 40) };
}


/** A byte count, shown as a size. */
export function bytes(label: string, value: number | null | undefined): Row {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { kind: 'bytes', label, value } : null;
}

/** A usage bar in bytes, or the used amount alone when the total is unknown. */
export function bytesMeter(label: string, used: number | undefined, total: number | undefined): Row {
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
    return { kind: 'meter', label, used, total, unit: 'bytes' };
  }
  return bytes(label, used);
}

/** A value of unknown type: a boolean, number or text row, whichever it is. */
export function any(label: string, value: unknown): Row {
  if (typeof value === 'boolean') return bool(label, value);
  if (typeof value === 'number') return num(label, value);
  return text(label, str(value));
}

/** A label from upstream text: plain, non-empty, within the label cap. */
export function upstreamLabel(value: string | undefined, fallback: string): string {
  const cleaned = value ? clean(value, 120).trim() : '';
  return cleaned || fallback;
}

/** "end_of_life" as "End of life". */
export function humanize(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** An upper-case enum value ("NEEDS_ATTENTION") as "Needs attention". */
export function enumLabel(value: string | undefined): string | undefined {
  return humanize(value?.toLowerCase());
}

/** Binary size: "512 MB", "15.9 GB". */
export function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 || unit === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

/** Disk capacity as sold (decimal): "512 GB", "2 TB", "1.9 TB". */
export function formatDiskSize(value: number): string {
  if (value >= 1e12) return `${Number((value / 1e12).toFixed(1))} TB`;
  return `${Math.round(value / 1e9)} GB`;
}

type Obj = Record<string, unknown>;

/** A trimmed non-empty string, else undefined. */
export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A plain object, else undefined. */
export const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);

/** The plain objects of an array; anything else is dropped. */
export const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((o): o is Obj => o !== undefined) : []);

/** A finite number, or a numeric string as one; else undefined. */
export const fin = (v: unknown): number | undefined => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

/** The strings of an array (objects give their `name` or `address`). */
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : str(obj(x)?.name) ?? str(obj(x)?.address))).filter((x): x is string => !!x) : [];

/** Present values only, cleaned: a fact the source does not report is omitted, never cleared. */
export function facts(values: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) if (value) out[key] = clean(value, 1_000);
  return out;
}

/** "aa:bb:cc:dd:ee:ff" from any 12-hex-digit spelling, else undefined. */
export function normalizeMac(value: string | undefined): string | undefined {
  const hex = value?.replace(/[^0-9a-f]/gi, '').toLowerCase();
  return hex && hex.length === 12 && /^[0-9a-f]{12}$/.test(hex) ? hex.match(/../g)!.join(':') : undefined;
}

const PHONE = new PhoneStrategy();

/** E.164 the PHONE field accepts; anything with letters (extensions) or too short is omitted. */
export function normalizePhone(value: string | undefined): string | undefined {
  if (!value || !/^[\d\s()+.-]+$/.test(value)) return undefined;
  const e164 = PHONE.normalize(value);
  return typeof e164 === 'string' && PHONE.valueSchema().safeParse(e164).success ? e164 : undefined;
}

/** An https link row, or a text row when the URL is not https. */
export function link(label: string, url: string | null | undefined, linkText?: string): Row {
  if (!url) return linkText ? text(label, linkText) : null;
  if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 2048) return linkText ? text(label, linkText) : null;
  return { kind: 'link', label: clean(label, 120), value: url, ...(linkText ? { text: clean(linkText, 120) } : {}) };
}
