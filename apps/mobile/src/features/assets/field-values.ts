import {
  FieldTypeValues,
  coerceTagChips,
  toAssetWireTags,
  type CreateAssetInput,
  type FieldType,
  type FileFieldEntry,
  type TagChipDraft,
  type UpdateAssetInput,
} from '@weavestream/shared';
import {
  extractFieldIssues,
  extractUniqueViolation,
  isArchivedAssetEditError,
  ARCHIVED_ASSET_EDIT_MESSAGE,
  type AssetRecord,
  type LayoutFieldRecord,
} from './api';
import { ApiError } from '../../lib/api';

/**
 * The pure core of the asset form: editor-value model, seeding, dirty
 * tracking, wire mapping, and the payload builders. No React, no fetch.
 *
 * THE CARDINAL RULE (build plan, Phase 2c): `persistFieldValues` treats
 * an omitted slug as untouched and an explicit `null` as delete. So the
 * PATCH payload is built from DIRTY slugs only, and the types mobile
 * cannot edit (RICH_TEXT, VAULTWARDEN_LINK, unknown) are NEVER present
 * in any payload — omission is the preservation mechanism.
 *
 * SEED-PROJECTION PRINCIPLE: dirty is measured against the *projection*
 * the editor was seeded with (the passwords `buildUpdatePayload`
 * precedent, generalized). Any lossy seed projection is therefore
 * harmless for untouched fields — equal projections → slug omitted →
 * the stored value survives verbatim. Concretely: a zone-suffixed
 * DATETIME seeds as its first 16 chars for `datetime-local`; NUMBER
 * seeds as a string; unparseable garbage seeds as `''`. Only a
 * deliberate edit replaces the stored value, and then in the same
 * no-offset convention the desktop writes.
 *
 * NAME CLOBBER GUARD: `update()` re-derives `Asset.name` from the
 * primary field whenever `name` is omitted from a PATCH. The desktop
 * form always re-sends the seeded name, so custom names survive edits
 * — mobile must do the same. `buildUpdateAssetPayload` therefore
 * always attaches the (trimmed, non-empty) name, even when unchanged;
 * clearing the name field is the deliberate "reset to derived" gesture
 * (desktop parity: `name.trim() || undefined`).
 */

// ─── Editor value model ────────────────────────────────────────────

export interface FileEntryDraft {
  /** The bare wire entry (exactly the fileFieldEntrySchema keys). */
  entry: FileFieldEntry;
  /** Display-only; never serialized back. */
  thumbnailUrl: string | null;
  downloadUrl: string | null;
}

export interface ReferenceDraft {
  id: string;
  /** Sidecar name; null = missing (deleted / cross-tenant). */
  name: string | null;
  archived: boolean;
}

export type FieldEditorValue =
  | { kind: 'text'; text: string }
  | { kind: 'boolean'; on: boolean }
  | { kind: 'dropdown'; other: boolean; choice: string; otherText: string }
  | { kind: 'multiselect'; slugs: string[] }
  | { kind: 'tags'; chips: TagChipDraft[] }
  | { kind: 'reference'; refs: ReferenceDraft[] }
  | { kind: 'file'; entries: FileEntryDraft[] }
  | { kind: 'readonly' };

export interface AssetFormModel {
  values: Record<string, FieldEditorValue>;
  /** Frozen snapshot from `seedAssetForm`; dirty compares against it. */
  seeds: Record<string, FieldEditorValue>;
}

// ─── Type gates ────────────────────────────────────────────────────

const KNOWN_TYPES: ReadonlySet<string> = new Set(FieldTypeValues);

/**
 * The single choke point for the wire's `fieldType: string`: the enum
 * will grow, and an unknown value must degrade to read-only, never
 * crash a screen in a server closet.
 */
export function isKnownFieldType(t: string): t is FieldType {
  return KNOWN_TYPES.has(t);
}

/** RICH_TEXT and VAULTWARDEN_LINK render read-only on mobile (v1). */
export function isMobileEditableFieldType(t: string): boolean {
  return isKnownFieldType(t) && t !== 'RICH_TEXT' && t !== 'VAULTWARDEN_LINK';
}

/**
 * Required fields the mobile form cannot satisfy. The API enforces
 * `isRequired` on EVERY field at create (`build-asset-schema.ts` —
 * update mode makes everything optional), so a layout with a required
 * read-only field makes the create form unsatisfiable: the chooser
 * marks it "Requires desktop" and the form blocks with guidance.
 */
export function unsatisfiableRequiredFields(
  layoutFields: LayoutFieldRecord[],
): LayoutFieldRecord[] {
  return activeFields(layoutFields).filter(
    (f) => f.isRequired && !isMobileEditableFieldType(f.fieldType),
  );
}

function activeFields(layoutFields: LayoutFieldRecord[]): LayoutFieldRecord[] {
  return layoutFields.filter((f) => f.archivedAt === null);
}

// ─── Seeding ───────────────────────────────────────────────────────

const TEXT_KINDS: ReadonlySet<string> = new Set([
  'TEXT',
  'TEXTAREA',
  'EMAIL',
  'PHONE',
  'URL',
  'IP_ADDRESS',
  'NUMBER',
  'DATE',
  'DATETIME',
]);

export function seedAssetForm(
  layoutFields: LayoutFieldRecord[],
  asset: AssetRecord | null,
): AssetFormModel {
  const seeds: Record<string, FieldEditorValue> = {};
  for (const field of activeFields(layoutFields)) {
    seeds[field.slug] = seedValue(field, asset);
  }
  return { values: { ...seeds }, seeds };
}

function seedValue(
  field: LayoutFieldRecord,
  asset: AssetRecord | null,
): FieldEditorValue {
  if (!isMobileEditableFieldType(field.fieldType)) return { kind: 'readonly' };
  const value = asset ? asset.fieldValues[field.slug] : undefined;

  switch (field.fieldType) {
    case 'BOOLEAN':
      // Absence seeds as off; untouched off stays equal to its seed and
      // is omitted on edit, so absence is never materialized into a row.
      return { kind: 'boolean', on: value === true };
    case 'DROPDOWN': {
      const choices = choiceSlugs(field.options);
      // No configured choices: the server degrades to a free string —
      // so does the editor (plain text input).
      if (choices.length === 0) return { kind: 'text', text: asString(value) };
      const current = asString(value);
      if (current !== '' && !choices.includes(current)) {
        if (field.options['allowOther'] === true) {
          return { kind: 'dropdown', other: true, choice: '', otherText: current };
        }
        // Out-of-catalog without allowOther: the editor injects the raw
        // value as a selectable option so the seed round-trips.
        return { kind: 'dropdown', other: false, choice: current, otherText: '' };
      }
      return { kind: 'dropdown', other: false, choice: current, otherText: '' };
    }
    case 'MULTISELECT':
      return {
        kind: 'multiselect',
        slugs: Array.isArray(value)
          ? value.filter((v): v is string => typeof v === 'string')
          : [],
      };
    case 'TAGS':
      return { kind: 'tags', chips: coerceTagChips(value) };
    case 'ASSET_REFERENCE': {
      const ids = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string')
        : typeof value === 'string' && value.length > 0
          ? [value]
          : [];
      return {
        kind: 'reference',
        refs: ids.map((id) => {
          const entry = asset?.references[id];
          return {
            id,
            name: entry?.name ?? null,
            archived: entry?.archivedAt != null,
          };
        }),
      };
    }
    case 'FILE': {
      const entries: FileEntryDraft[] = [];
      if (Array.isArray(value)) {
        for (const raw of value) {
          const draft = toFileEntryDraft(raw);
          if (draft) entries.push(draft);
        }
      }
      return { kind: 'file', entries };
    }
    default: {
      if (!TEXT_KINDS.has(field.fieldType)) return { kind: 'readonly' };
      if (field.fieldType === 'NUMBER') {
        return {
          kind: 'text',
          text: typeof value === 'number' && Number.isFinite(value) ? String(value) : '',
        };
      }
      if (field.fieldType === 'DATE') {
        return { kind: 'text', text: asString(value).slice(0, 10) };
      }
      if (field.fieldType === 'DATETIME') {
        // datetime-local wants YYYY-MM-DDTHH:mm; a zone-suffixed stored
        // value loses its suffix in the editor — harmless untouched
        // (seed-projection principle), desktop-convention when edited.
        return { kind: 'text', text: asString(value).slice(0, 16) };
      }
      return { kind: 'text', text: asString(value) };
    }
  }
}

/** Explicit five-key pick — hydration URLs must never re-enter the wire. */
function toFileEntryDraft(raw: unknown): FileEntryDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['uploadId'] !== 'string' || typeof obj['filename'] !== 'string') {
    return null;
  }
  const entry: FileFieldEntry = {
    uploadId: obj['uploadId'],
    filename: obj['filename'],
    mimeType: typeof obj['mimeType'] === 'string' ? obj['mimeType'] : 'application/octet-stream',
    sizeBytes:
      typeof obj['sizeBytes'] === 'number' && Number.isFinite(obj['sizeBytes'])
        ? obj['sizeBytes']
        : 1,
    ...(typeof obj['isImage'] === 'boolean' ? { isImage: obj['isImage'] } : {}),
  };
  return {
    entry,
    thumbnailUrl: typeof obj['thumbnailUrl'] === 'string' ? obj['thumbnailUrl'] : null,
    downloadUrl: typeof obj['downloadUrl'] === 'string' ? obj['downloadUrl'] : null,
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function choiceSlugs(options: Record<string, unknown>): string[] {
  const choices = options['choices'];
  if (!Array.isArray(choices)) return [];
  return choices.flatMap((c) =>
    c && typeof c === 'object' && typeof (c as { slug?: unknown }).slug === 'string'
      ? [(c as { slug: string }).slug]
      : [],
  );
}

// ─── Wire mapping ──────────────────────────────────────────────────

/**
 * The wire value for one field: `null` = empty/cleared (delete on
 * update, omitted on create), `undefined` = do not serialize (readonly
 * kinds, and NUMBER parse failures — the caller blocks Save on those
 * via `invalidNumberSlugs`).
 */
export function toWireValue(
  field: Pick<LayoutFieldRecord, 'fieldType'>,
  value: FieldEditorValue,
): unknown {
  switch (value.kind) {
    case 'readonly':
      return undefined;
    case 'boolean':
      // Always true|false, never null — on create this deliberately
      // sends explicit false (matches desktop-created assets, and an
      // isRequired toggle left off must not 400 as "missing").
      return value.on;
    case 'dropdown': {
      if (value.other) {
        const t = value.otherText.trim();
        return t === '' ? null : t;
      }
      return value.choice === '' ? null : value.choice;
    }
    case 'multiselect':
      return value.slugs.length > 0 ? [...value.slugs] : null;
    case 'tags':
      return value.chips.length > 0 ? toAssetWireTags(value.chips) : null;
    case 'reference':
      // Always string[] — a single-target field sends a 1-element array
      // (the server widens bare uuids but never requires one).
      return value.refs.length > 0 ? value.refs.map((r) => r.id) : null;
    case 'file':
      return value.entries.length > 0 ? value.entries.map((d) => d.entry) : null;
    case 'text': {
      switch (field.fieldType) {
        case 'TEXTAREA':
          // Server keeps TEXTAREA untrimmed; only exactly-empty clears.
          return value.text === '' ? null : value.text;
        case 'NUMBER': {
          if (value.text.trim() === '') return null;
          const n = Number(value.text);
          return Number.isFinite(n) ? n : undefined;
        }
        default: {
          const t = value.text.trim();
          return t === '' ? null : t;
        }
      }
    }
  }
}

/**
 * Canonical string for dirty comparison. Unordered collections
 * (MULTISELECT, TAGS, ASSET_REFERENCE) compare order-insensitively so
 * toggle-off-then-on is not spuriously dirty; FILE compares the entry
 * sequence (order is user-visible tile order).
 */
function wireNorm(
  field: Pick<LayoutFieldRecord, 'fieldType'>,
  value: FieldEditorValue,
): string {
  const wire = toWireValue(field, value);
  if (wire === undefined) return '__unserialized__';
  if (Array.isArray(wire)) {
    switch (value.kind) {
      case 'multiselect':
      case 'reference':
        return JSON.stringify([...(wire as string[])].sort());
      case 'tags':
        return JSON.stringify(
          [...(wire as Array<string | { name: string }>)].sort((a, b) =>
            tagSortKey(a).localeCompare(tagSortKey(b)),
          ),
        );
      default:
        return JSON.stringify(wire);
    }
  }
  return JSON.stringify(wire ?? null);
}

function tagSortKey(entry: string | { name: string }): string {
  return typeof entry === 'string' ? `id:${entry}` : `name:${entry.name.toLowerCase()}`;
}

export function isFieldDirty(
  field: Pick<LayoutFieldRecord, 'fieldType'>,
  seed: FieldEditorValue,
  current: FieldEditorValue,
): boolean {
  return wireNorm(field, seed) !== wireNorm(field, current);
}

/** NUMBER fields whose current text does not parse — Save must block. */
export function invalidNumberSlugs(
  layoutFields: LayoutFieldRecord[],
  model: AssetFormModel,
): string[] {
  const out: string[] = [];
  for (const field of activeFields(layoutFields)) {
    if (field.fieldType !== 'NUMBER') continue;
    const value = model.values[field.slug];
    if (!value || value.kind !== 'text') continue;
    if (value.text.trim() === '') continue;
    if (!Number.isFinite(Number(value.text))) out.push(field.slug);
  }
  return out;
}

/**
 * Editable required fields whose wire value is null — the create-time
 * pre-check (`mode: 'create'` is the only mode the server enforces
 * required on). BOOLEAN can never appear here: its wire value is always
 * true|false, and a visible toggle showing "off" IS an answer.
 */
export function missingRequiredSlugs(
  layoutFields: LayoutFieldRecord[],
  model: AssetFormModel,
): string[] {
  const out: string[] = [];
  for (const field of activeFields(layoutFields)) {
    if (!field.isRequired || !isMobileEditableFieldType(field.fieldType)) continue;
    const value = model.values[field.slug];
    if (!value || value.kind === 'readonly') continue;
    if (toWireValue(field, value) === null) out.push(field.slug);
  }
  return out;
}

// ─── Payload builders ──────────────────────────────────────────────

export function buildCreateAssetPayload(
  assetLayoutId: string,
  name: string,
  layoutFields: LayoutFieldRecord[],
  model: AssetFormModel,
): CreateAssetInput {
  const fieldValues: Record<string, unknown> = {};
  for (const field of activeFields(layoutFields)) {
    const value = model.values[field.slug];
    if (!value || value.kind === 'readonly') continue;
    const wire = toWireValue(field, value);
    // null and omitted are identical on create (no row either way), so
    // empties are simply left out. BOOLEAN's wire is never null, which
    // is what makes explicit false always present.
    if (wire === undefined || wire === null) continue;
    fieldValues[field.slug] = wire;
  }
  const trimmed = name.trim();
  return {
    assetLayoutId,
    ...(trimmed !== '' ? { name: trimmed } : {}),
    fieldValues,
  };
}

/**
 * Diff-only PATCH payload, or `null` when nothing changed (Save stays
 * disabled — `updateAssetSchema` requires ≥1 key anyway).
 */
export function buildUpdateAssetPayload(
  originalName: string,
  name: string,
  layoutFields: LayoutFieldRecord[],
  model: AssetFormModel,
): UpdateAssetInput | null {
  const dirty: Record<string, unknown> = {};
  for (const field of activeFields(layoutFields)) {
    const seed = model.seeds[field.slug];
    const current = model.values[field.slug];
    if (!seed || !current || current.kind === 'readonly') continue;
    if (!isFieldDirty(field, seed, current)) continue;
    const wire = toWireValue(field, current);
    // Unserializable current value (NUMBER garbage): the screen blocks
    // Save via invalidNumberSlugs; skipping here keeps the builder total.
    if (wire === undefined) continue;
    dirty[field.slug] = wire; // null = deliberate clear (deleteMany)
  }

  const trimmedName = name.trim();
  const nameChanged = trimmedName !== originalName;
  const dirtyCount = Object.keys(dirty).length;
  if (!nameChanged && dirtyCount === 0) return null;

  if (trimmedName !== '') {
    // ALWAYS attached when non-empty, even unchanged — an omitted name
    // makes the server re-derive from the primary field and clobber a
    // desktop-set custom name.
    return {
      name: trimmedName,
      ...(dirtyCount > 0 ? { fieldValues: dirty } : {}),
    };
  }
  // Cleared name: omit the key so the server re-derives (the designed
  // reset); an empty fieldValues map keeps the ≥1-key refine satisfied
  // when nothing else changed.
  return { fieldValues: dirty };
}

// ─── Server-error mapping ──────────────────────────────────────────

export interface AssetWriteErrorView {
  formError: string | null;
  fieldErrors: Record<string, string>;
}

export function mapAssetWriteError(
  err: unknown,
  knownSlugs: ReadonlySet<string>,
): AssetWriteErrorView {
  const issues = extractFieldIssues(err);
  if (issues) {
    const fieldErrors: Record<string, string> = {};
    const unknown: string[] = [];
    for (const [slug, message] of Object.entries(issues)) {
      if (knownSlugs.has(slug)) fieldErrors[slug] = message;
      else unknown.push(`${slug}: ${message}`);
    }
    return {
      formError:
        unknown.length > 0
          ? `Fix the highlighted fields. Also: ${unknown.join('; ')}`
          : 'Fix the highlighted fields and try again.',
      fieldErrors,
    };
  }

  const unique = extractUniqueViolation(err);
  if (unique) {
    const message = unique.conflictingAssetName
      ? `Already used by “${unique.conflictingAssetName}”.`
      : (unique.message ?? 'This value is already used by another asset.');
    if (knownSlugs.has(unique.slug)) {
      return { formError: null, fieldErrors: { [unique.slug]: message } };
    }
    return { formError: message, fieldErrors: {} };
  }

  if (isArchivedAssetEditError(err)) {
    return { formError: ARCHIVED_ASSET_EDIT_MESSAGE, fieldErrors: {} };
  }

  if (err instanceof ApiError) {
    const problem = err.problem as
      | { error?: unknown; detail?: unknown; message?: unknown }
      | undefined;
    // ClientVisibilityViolation (403) carries a slug too — defensive:
    // client-invisible fields aren't rendered for client users at all.
    if (problem?.error === 'ClientVisibilityViolation') {
      const slug = (problem as { slug?: unknown }).slug;
      if (typeof slug === 'string' && knownSlugs.has(slug)) {
        return {
          formError: null,
          fieldErrors: { [slug]: 'This field cannot be edited by client users.' },
        };
      }
    }
    const detail =
      typeof problem?.detail === 'string' && problem.detail !== 'ValidationError'
        ? problem.detail
        : typeof problem?.message === 'string'
          ? problem.message
          : null;
    return { formError: detail ?? "Couldn't save the asset. Try again.", fieldErrors: {} };
  }

  return { formError: "Couldn't save the asset. Try again.", fieldErrors: {} };
}
