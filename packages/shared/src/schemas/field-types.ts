import { z } from 'zod';

/**
 * Canonical field-type catalog for Phase 3 dynamic asset forms and layouts.
 *
 * This file is the **single source of truth shared between web and api**:
 * - Web: used for the field-type palette, the inspector type-select, width
 *   rules in the asset form grid, and label rendering in lists / details.
 * - API: imported by the `FieldTypeStrategy` registry to keep slugs / labels
 *   / icon keys / composite flags in lockstep. Each strategy implementation
 *   lives in `apps/api/src/field-types/` and adds per-kind Zod schemas and
 *   onRelate hooks; this file stays deliberately minimal so web bundles
 *   don't pull in server-only logic.
 */

export const FieldTypeValues = [
  'TEXT',
  'TEXTAREA',
  'RICH_TEXT',
  'NUMBER',
  'DATE',
  'DATETIME',
  'BOOLEAN',
  'DROPDOWN',
  'MULTISELECT',
  'EMAIL',
  'PHONE',
  'IP_ADDRESS',
  'URL',
  'ASSET_REFERENCE',
  'VAULTWARDEN_LINK',
  'FILE',
  'TAGS',
] as const;

export type FieldType = (typeof FieldTypeValues)[number];

/** Icon key from the `@weavestream/web` icon set — rendered in the palette and the field row. */
export type FieldTypeIcon =
  | 'text'
  | 'align'
  | 'doc'
  | 'hash'
  | 'calendar'
  | 'clock'
  | 'check'
  | 'caret'
  | 'list'
  | 'mail'
  | 'phone'
  | 'network'
  | 'globe'
  | 'link'
  | 'key'
  | 'box'
  | 'tag';


export type FieldWidth = 'half' | 'full';

export interface FieldTypeMeta {
  /** Enum value used everywhere in DB + API. */
  kind: FieldType;
  /** Human label — shown in palette rows, inspector select, form labels. */
  label: string;
  /** Lowercase slug used as the mono identifier in the palette (matches the mock). */
  slug: string;
  /** Icon key (see `FieldTypeIcon`). */
  icon: FieldTypeIcon;
  /** Width rule in the 2-column asset form grid (`screens1.jsx::AssetForm`). */
  width: FieldWidth;
  /**
   * Composite inputs render a chip bag or multi-control UI rather than a
   * single `<input>` — useful for the web side to switch between input
   * components without another lookup.
   */
  composite: boolean;
  /**
   * Whether the stored `value` can meaningfully appear as a middle column
   * on the asset list (and as a `field.<slug>=` filter). Phase 3 limits
   * filters to types that have a flat scalar representation.
   */
  filterable: boolean;
  /**
   * Types whose `AssetField.options` object must be declared in the
   * inspector. Drives whether the inspector shows the "Options" sub-section.
   */
  hasOptions: boolean;
  /** Notes surfaced in the inspector hint row (optional). */
  hint?: string;
}

/**
 * Ordered exactly as the `screens1.jsx::LayoutBuilder` palette so the UI
 * can iterate this array directly without re-sorting.
 */
export const FIELD_TYPE_CATALOG: readonly FieldTypeMeta[] = [
  {
    kind: 'TEXT',
    label: 'Text',
    slug: 'text',
    icon: 'text',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: false,
  },
  {
    kind: 'TEXTAREA',
    label: 'Textarea',
    slug: 'textarea',
    icon: 'align',
    width: 'full',
    composite: false,
    filterable: false,
    hasOptions: false,
  },
  {
    kind: 'RICH_TEXT',
    label: 'Rich text',
    slug: 'rich_text',
    icon: 'doc',
    width: 'full',
    composite: true,
    filterable: false,
    hasOptions: false,
    hint: 'Tiptap editor with slash commands for blocks and @ to link assets or articles.',
  },
  {
    kind: 'NUMBER',
    label: 'Number',
    slug: 'number',
    icon: 'hash',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: false,
  },
  {
    kind: 'DATE',
    label: 'Date',
    slug: 'date',
    icon: 'calendar',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: true,
    hint: 'Mark as expiry to drive warranty countdown chips.',
  },
  {
    kind: 'DATETIME',
    label: 'Date-time',
    slug: 'datetime',
    icon: 'clock',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: true,
  },
  {
    kind: 'BOOLEAN',
    label: 'Boolean',
    slug: 'boolean',
    icon: 'check',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: false,
  },
  {
    kind: 'DROPDOWN',
    label: 'Dropdown',
    slug: 'dropdown',
    icon: 'caret',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: true,
  },
  {
    kind: 'MULTISELECT',
    label: 'Multi-select',
    slug: 'multiselect',
    icon: 'list',
    width: 'full',
    composite: true,
    filterable: false,
    hasOptions: true,
  },
  {
    kind: 'EMAIL',
    label: 'Email',
    slug: 'email',
    icon: 'mail',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: false,
  },
  {
    kind: 'PHONE',
    label: 'Phone',
    slug: 'phone',
    icon: 'phone',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: false,
  },
  {
    kind: 'IP_ADDRESS',
    label: 'IP address',
    slug: 'ip_address',
    icon: 'network',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: true,
    hint: 'Accepts IPv4 or IPv6. Enable CIDR to store subnets (e.g. 10.0.0.0/24). Powers the upcoming IPAM feature.',
  },
  {
    kind: 'URL',
    label: 'URL',
    slug: 'url',
    icon: 'globe',
    width: 'half',
    composite: false,
    filterable: true,
    hasOptions: false,
  },
  {
    kind: 'ASSET_REFERENCE',
    label: 'Asset',
    slug: 'asset_reference',
    icon: 'link',
    width: 'full',
    composite: true,
    filterable: false,
    hasOptions: true,
    hint: 'Populates the polymorphic Relation table so picks appear in the Linked items rail.',
  },
  {
    kind: 'VAULTWARDEN_LINK',
    label: 'Vault link',
    slug: 'vaultwarden_link',
    icon: 'key',
    width: 'half',
    composite: false,
    filterable: false,
    hasOptions: false,
  },
  {
    kind: 'FILE',
    label: 'File',
    slug: 'file',
    icon: 'box',
    width: 'full',
    composite: true,
    filterable: false,
    hasOptions: true,
    hint: 'Uploads stream through the API to local storage; cap per-field size via the Max size option.',
  },
  {
    kind: 'TAGS',
    label: 'Tags',
    slug: 'tags',
    icon: 'tag',
    width: 'full',
    composite: true,
    filterable: false,
    hasOptions: false,
  },
];

const META_BY_KIND: Record<FieldType, FieldTypeMeta> = Object.fromEntries(
  FIELD_TYPE_CATALOG.map((m) => [m.kind, m]),
) as Record<FieldType, FieldTypeMeta>;

export function getFieldTypeMeta(kind: FieldType): FieldTypeMeta {
  return META_BY_KIND[kind];
}

/** Types whose `field.<slug>=` filters are accepted by the Phase 3 list endpoint. */
export const FILTERABLE_FIELD_TYPES: ReadonlySet<FieldType> = new Set(
  FIELD_TYPE_CATALOG.filter((m) => m.filterable).map((m) => m.kind),
);

/**
 * Shape of a single option on a DROPDOWN/MULTISELECT field. Stored as JSON
 * inside `AssetField.options.choices`. Label is free-form, slug is a
 * stable lowercase identifier so renames don't invalidate stored values.
 */
export const fieldOptionChoiceSchema = z.object({
  label: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, 'Option slug must be lowercase snake_case'),
});
export type FieldOptionChoice = z.infer<typeof fieldOptionChoiceSchema>;
