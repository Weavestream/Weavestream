import type { FieldType } from '@weavestream/shared';

export type BuilderField = {
  /** Persisted id, or undefined for unsaved rows. */
  id?: string;
  /** Stable key across the builder's lifetime — required by @dnd-kit. */
  key: string;
  name: string;
  slug: string;
  fieldType: FieldType;
  isRequired: boolean;
  isUniquePerCompany: boolean;
  visibleToClients: boolean;
  isPrimary: boolean;
  /**
   * When true, this field is rendered as a column in the per-layout
   * asset table view. The primary field is implicitly included as the
   * first column, so `isPrimary` effectively wins and the inspector
   * locks the toggle there.
   */
  showInTable: boolean;
  options: Record<string, unknown>;
};

/** What is under the pointer while a drag is in flight. */
type BuilderDrag =
  | { kind: 'palette'; fieldType: FieldType }
  | { kind: 'field'; key: string }
  | null;

export type BuilderState = {
  fields: BuilderField[];
  /**
   * The last-known-persisted snapshot. Dirty state compares current
   * `fields` against this, so a successful save can reset the baseline
   * in one place and the "unsaved" chip disappears without waiting for
   * the parent server component to hand us fresh props.
   */
  baseline: BuilderField[];
  selectedKey: string | null;
  drag: BuilderDrag;
};

export type BuilderAction =
  /** Insert a new field of `fieldType` at `atIndex` (default: end) and select it. */
  | { type: 'add'; fieldType: FieldType; key: string; atIndex?: number }
  | { type: 'remove'; key: string }
  | { type: 'update'; key: string; patch: Partial<BuilderField> }
  /** Transfer the primary designation to `key`, demoting the old one atomically. */
  | { type: 'setPrimary'; key: string }
  | { type: 'select'; key: string | null }
  | { type: 'dragStart'; activeId: string }
  /**
   * Palette → canvas inserts a field at the drop target; canvas → canvas
   * reorders. `key` is the key a palette drop would give its new row.
   */
  | { type: 'dragEnd'; activeId: string; overId: string | null; key: string }
  /**
   * Replace the working copy with starter-template fields. `baseline`
   * is intentionally left alone so the "unsaved" chip lights up.
   */
  | { type: 'seed'; fields: BuilderField[] }
  /** Take a fresh server snapshot as both working copy and baseline. */
  | { type: 'reset'; fields: BuilderField[] }
  /**
   * A save succeeded. `sent` is the working copy that was submitted;
   * `serverFields` is the server's response, or null when it shipped
   * none and `sent` becomes the new baseline.
   */
  | { type: 'saved'; sent: BuilderField[]; serverFields: BuilderField[] | null };
