import type { CompanyType } from './server-api';
import type { TagTone } from '../components/ui';

// Stable per-id brand accent. Kept as a plain function so every caller
// (tables, headers, avatar fallbacks) resolves to the same color for
// the same company id across the app.
const accentColors = [
  'var(--info)',
  'var(--ok)',
  'var(--warn)',
  'var(--accent)',
  'oklch(0.74 0.17 270)',
  'oklch(0.74 0.18 25)',
];

export function companyAccent(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return accentColors[h % accentColors.length]!;
}

// Lightweight lookup tables for the CompanyType enum — labels in
// sentence case, tones aligned with the existing Tag palette.
const TYPE_LABELS: Record<CompanyType, string> = {
  CLIENT: 'Client',
  PROSPECT: 'Prospect',
  VENDOR: 'Vendor',
  INTERNAL: 'Internal',
  PARTNER: 'Partner',
  OTHER: 'Other',
};

const TYPE_TONES: Record<CompanyType, TagTone> = {
  CLIENT: 'accent',
  PROSPECT: 'info',
  VENDOR: 'warn',
  INTERNAL: 'default',
  PARTNER: 'ok',
  OTHER: 'outline',
};

export function companyTypeLabel(type: CompanyType): string {
  return TYPE_LABELS[type] ?? type;
}

export function companyTypeTone(type: CompanyType): TagTone {
  return TYPE_TONES[type] ?? 'default';
}

export const companyTypeOptions: Array<{ value: CompanyType; label: string }> =
  (Object.keys(TYPE_LABELS) as CompanyType[]).map((value) => ({
    value,
    label: TYPE_LABELS[value],
  }));

export interface CompanyAddressShape {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
}

/**
 * Split a Company's address into renderable lines. Returns an empty
 * array when no address fields are set — callers can branch on that to
 * show an empty-state CTA.
 */
export function formatAddressLines(addr: CompanyAddressShape): string[] {
  const lines: string[] = [];
  if (addr.addressLine1) lines.push(addr.addressLine1);
  if (addr.addressLine2) lines.push(addr.addressLine2);
  const cityRegionZip = [
    addr.city,
    addr.region,
    addr.postalCode,
  ]
    .filter((p): p is string => Boolean(p && p.trim().length > 0))
    .join(addr.region && addr.city ? ', ' : ' ')
    .trim();
  if (cityRegionZip) lines.push(cityRegionZip);
  if (addr.country) lines.push(addr.country);
  return lines;
}

export function buildMapsUrl(addr: CompanyAddressShape): string | null {
  const parts = [
    addr.addressLine1,
    addr.addressLine2,
    addr.city,
    addr.region,
    addr.postalCode,
    addr.country,
  ]
    .map((p) => (p ?? '').trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    parts.join(', '),
  )}`;
}

// Slug normalizer shared by create + settings forms.
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 40);
}
