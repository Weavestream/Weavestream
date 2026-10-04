import { arrayMove } from '@dnd-kit/sortable';
import { randomClientId } from '@weavestream/shared/browser';
import {
  type FieldType,
  type LayoutFieldSummary,
  type LayoutTemplateField,
  type SaveAssetFieldsInput,
  canShowInTable,
  fieldOptionsSchemaFor,
  saveAssetFieldsSchema,
} from '@weavestream/shared';
import type { BuilderAction, BuilderField, BuilderState } from './types';

/**
 * Pure state for the layout builder. Everything here is free of React
 * and the network so add/remove/reorder/primary rules and the dirty
 * check can be tested without rendering the builder.
 */

export const PALETTE_DRAG_PREFIX = 'palette:';
export const CANVAS_DROPZONE_ID = 'canvas-dropzone';

export const newKey = () => `new-${randomClientId()}`;

export function toBuilder(f: LayoutFieldSummary): BuilderField {
  return {
    id: f.id,
    key: f.id,
    name: f.name,
    slug: f.slug,
    fieldType: f.fieldType,
    isRequired: f.isRequired,
    isUniquePerCompany: f.isUniquePerCompany,
    visibleToClients: f.visibleToClients,
    isPrimary: f.isPrimary,
    showInTable: f.showInTable,
    options: f.options ?? {},
  };
}

/** Persisted, non-archived fields in display order. */
export function activeLayoutFields(
  fields: readonly LayoutFieldSummary[],
): LayoutFieldSummary[] {
  return fields.filter((f) => !f.archivedAt).sort((a, b) => a.position - b.position);
}

function defaultOptionsFor(kind: FieldType): Record<string, unknown> {
  switch (kind) {
    // New DROPDOWN/MULTISELECT rows start with no choices so the operator
    // fills them in explicitly rather than shipping with a "Option A" stub
    // that looks like real data. The save validator requires ≥1 choice,
    // which surfaces as an inline error if they save an empty list.
    case 'DROPDOWN':
      return { choices: [], allowOther: false };
    case 'MULTISELECT':
      return { choices: [] };
    case 'DATE':
    case 'DATETIME':
      return { isExpiry: false };
    case 'ASSET_REFERENCE':
      return { targetLayoutId: '', multiple: false };
    case 'FILE':
      return { maxSizeMb: 25, multiple: false };
    case 'IP_ADDRESS':
      return { version: 'any', allowCidr: false };
    default:
      return {};
  }
}

/**
 * Starter-template rows. Fields are left without an `id` so the save
 * diff treats them as brand-new rows.
 */
export function fieldsFromTemplate(
  templateFields: readonly LayoutTemplateField[],
  makeKey: () => string = newKey,
): BuilderField[] {
  const hasPrimary = templateFields.some((f) => f.isPrimary === true);
  return templateFields.map((f, idx) => ({
    key: makeKey(),
    name: f.name,
    slug: f.slug,
    fieldType: f.fieldType,
    isRequired: f.isRequired ?? false,
    isUniquePerCompany: false,
    visibleToClients: f.visibleToClients ?? true,
    // Templates should always mark a primary, but fall back to the
    // first field if one is missing so the Save validator (which
    // requires exactly one primary) doesn't reject on load.
    isPrimary: f.isPrimary === true || (!hasPrimary && idx === 0),
    showInTable: (f.showInTable ?? false) && canShowInTable(f.fieldType),
    // Merge template-supplied options on top of the kind's default
    // skeleton so DROPDOWN/IP_ADDRESS/DATE keep all required keys
    // even if the template only overrides a subset.
    options: { ...defaultOptionsFor(f.fieldType), ...(f.options ?? {}) },
  }));
}

export function initialBuilderState(fields: BuilderField[]): BuilderState {
  return {
    fields,
    baseline: fields,
    selectedKey: fields[0]?.key ?? null,
    drag: null,
  };
}

export function isDirty(
  fields: readonly BuilderField[],
  baseline: readonly BuilderField[],
): boolean {
  if (fields.length !== baseline.length) return true;
  for (let i = 0; i < fields.length; i++) {
    const a = fields[i]!;
    const b = baseline[i]!;
    if (a.id !== b.id) return true;
    if (
      a.name !== b.name ||
      a.slug !== b.slug ||
      a.fieldType !== b.fieldType ||
      a.isRequired !== b.isRequired ||
      a.isUniquePerCompany !== b.isUniquePerCompany ||
      a.visibleToClients !== b.visibleToClients ||
      a.isPrimary !== b.isPrimary ||
      a.showInTable !== b.showInTable ||
      JSON.stringify(a.options) !== JSON.stringify(b.options)
    ) {
      return true;
    }
  }
  return false;
}

/** Columns the per-layout asset table would render: primary plus opted-in tabular fields. */
export function countTableColumns(fields: readonly BuilderField[]): number {
  return fields.filter(
    (f) => f.isPrimary || (f.showInTable && canShowInTable(f.fieldType)),
  ).length;
}

function addField(
  state: BuilderState,
  fieldType: FieldType,
  key: string,
  atIndex?: number,
): BuilderState {
  const hasPrimary = state.fields.some((f) => f.isPrimary);
  // New rows start with empty label + slug so the inspector renders a
  // placeholder hint instead of "Text"/"text" stubs that look like real
  // values. The label → slug auto-fill keeps them linked until the user
  // touches the slug manually; save validation enforces non-empty.
  const next: BuilderField = {
    key,
    name: '',
    slug: '',
    fieldType,
    isRequired: false,
    isUniquePerCompany: false,
    visibleToClients: true,
    isPrimary: !hasPrimary,
    showInTable: false,
    options: defaultOptionsFor(fieldType),
  };
  const fields = [...state.fields];
  fields.splice(atIndex ?? fields.length, 0, next);
  return { ...state, fields, selectedKey: key };
}

/**
 * Drop handling. Palette → canvas adds a new field at the target row
 * (or the end, for the dropzone or an unknown target); canvas → canvas
 * reorders.
 */
function endDrag(
  state: BuilderState,
  activeId: string,
  overId: string | null,
  key: string,
): BuilderState {
  const cleared: BuilderState = { ...state, drag: null };
  if (!overId) return cleared;

  if (activeId.startsWith(PALETTE_DRAG_PREFIX)) {
    const kind = activeId.slice(PALETTE_DRAG_PREFIX.length) as FieldType;
    const idx =
      overId === CANVAS_DROPZONE_ID
        ? cleared.fields.length
        : cleared.fields.findIndex((f) => f.key === overId);
    return addField(cleared, kind, key, idx < 0 ? cleared.fields.length : idx);
  }

  if (activeId === overId) return cleared;
  const fromIdx = cleared.fields.findIndex((f) => f.key === activeId);
  const toIdx = cleared.fields.findIndex((f) => f.key === overId);
  if (fromIdx < 0 || toIdx < 0) return cleared;
  return { ...cleared, fields: arrayMove(cleared.fields, fromIdx, toIdx) };
}

export function layoutBuilderReducer(
  state: BuilderState,
  action: BuilderAction,
): BuilderState {
  switch (action.type) {
    case 'add':
      return addField(state, action.fieldType, action.key, action.atIndex);

    case 'remove': {
      const fields = state.fields.filter((f) => f.key !== action.key);
      // A layout always has exactly one primary: removing it promotes
      // the first remaining field.
      if (fields.length > 0 && !fields.some((f) => f.isPrimary)) {
        fields[0] = { ...fields[0]!, isPrimary: true };
      }
      return {
        ...state,
        fields,
        selectedKey: state.selectedKey === action.key ? null : state.selectedKey,
      };
    }

    case 'update':
      return {
        ...state,
        fields: state.fields.map((f) =>
          f.key === action.key
            ? {
                ...f,
                ...action.patch,
                options: action.patch.options ? { ...action.patch.options } : f.options,
              }
            : f,
        ),
      };

    case 'setPrimary':
      return {
        ...state,
        fields: state.fields.map((f) => ({ ...f, isPrimary: f.key === action.key })),
      };

    case 'select':
      return { ...state, selectedKey: action.key };

    case 'dragStart':
      return {
        ...state,
        drag: action.activeId.startsWith(PALETTE_DRAG_PREFIX)
          ? {
              kind: 'palette',
              fieldType: action.activeId.slice(PALETTE_DRAG_PREFIX.length) as FieldType,
            }
          : { kind: 'field', key: action.activeId },
      };

    case 'dragEnd':
      return endDrag(state, action.activeId, action.overId, action.key);

    case 'seed':
      return { ...state, fields: action.fields, selectedKey: action.fields[0]?.key ?? null };

    case 'reset':
      return { ...state, fields: action.fields, baseline: action.fields };

    case 'saved': {
      const { sent, serverFields } = action;
      if (!serverFields) {
        return {
          ...state,
          baseline: sent.map((f) => ({ ...f, options: { ...f.options } })),
        };
      }
      // Re-anchor selection on the corresponding saved row, by slug
      // (stable across save) since the row's `key` just got replaced.
      const current = state.selectedKey
        ? sent.find((f) => f.key === state.selectedKey)
        : undefined;
      const replacement = current
        ? serverFields.find((f) => f.slug === current.slug)
        : undefined;
      return {
        ...state,
        fields: serverFields,
        baseline: serverFields,
        selectedKey: replacement?.key ?? null,
      };
    }
  }
}

/**
 * Build and validate the save body. Each field's options are checked
 * against the shared schema before the round-trip so the UI can show
 * an inline error instead of a server rejection.
 */
export function prepareSave(
  fields: readonly BuilderField[],
): { ok: true; payload: SaveAssetFieldsInput } | { ok: false; error: string } {
  const payload = {
    fields: fields.map((f, i) => ({
      ...(f.id ? { id: f.id } : {}),
      name: f.name,
      slug: f.slug,
      fieldType: f.fieldType,
      position: i,
      isRequired: f.isRequired,
      isUniquePerCompany: f.isUniquePerCompany,
      visibleToClients: f.visibleToClients,
      isPrimary: f.isPrimary,
      // Non-tabular types can never be table columns — strip the
      // flag defensively before sending so the server never sees a
      // stale value from a field whose type changed.
      showInTable: canShowInTable(f.fieldType) && f.showInTable,
      options: f.options,
    })),
  };

  for (const f of payload.fields) {
    const res = fieldOptionsSchemaFor(f.fieldType).safeParse(f.options);
    if (!res.success) {
      return {
        ok: false,
        error: `Field "${f.slug}" (${f.fieldType}) has invalid options: ${
          res.error.issues[0]?.message ?? 'check the inspector.'
        }`,
      };
    }
  }
  const parsed = saveAssetFieldsSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Fix the errors above.' };
  }
  return { ok: true, payload: parsed.data };
}
