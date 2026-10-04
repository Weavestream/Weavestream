'use client';

import type { LayoutSummary } from '@weavestream/shared';
import { FIELD_TYPE_CATALOG, canShowInTable } from '@weavestream/shared';
import { lower } from '../../../../../../../lib/term';
import { useTerm } from '../../../../../../../lib/term-context';
import { slugifyFieldSlug as slugify } from '../../../../../../../lib/slugify';
import {
  InspectorField,
  InspectorInput,
  ToggleRow,
  inspectorInputStyle,
} from './inspector-controls';
import { OptionsEditor } from './options-editor';
import type { BuilderField } from './types';

export function FieldInspector({
  field,
  canEdit,
  onChange,
  onSlugAutoFill,
  onMakePrimary,
  allLayouts,
  currentLayoutId,
}: {
  field: BuilderField | null;
  canEdit: boolean;
  onChange: (patch: Partial<BuilderField>) => void;
  onSlugAutoFill: (label: string) => void;
  /**
   * Transfer primary designation to this field. Uses a dedicated
   * callback (rather than `onChange({ isPrimary: true })`) so the
   * previous primary gets demoted atomically — `updateField` only
   * touches one row and would otherwise leave two primaries.
   */
  onMakePrimary: (key: string) => void;
  allLayouts: LayoutSummary[];
  currentLayoutId: string;
}) {
  const term = useTerm();
  if (!field) {
    return (
      <aside
        style={{
          padding: 18,
          borderLeft: '1px solid var(--line)',
          background: 'var(--surface)',
          color: 'var(--muted)',
          fontSize: 12.5,
        }}
      >
        Select a field to inspect.
      </aside>
    );
  }
  const meta = FIELD_TYPE_CATALOG.find((m) => m.kind === field.fieldType)!;
  const readOnly = !canEdit;
  const isPersisted = !!field.id;

  return (
    <aside
      style={{
        padding: 18,
        borderLeft: '1px solid var(--line)',
        background: 'var(--surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        minHeight: '100%',
        minWidth: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        Field inspector
      </div>

      <InspectorInput
        label="Label"
        value={field.name}
        placeholder={meta.label}
        readOnly={readOnly}
        onChange={(v) => {
          onChange({ name: v });
          if (!field.id) onSlugAutoFill(v);
        }}
      />

      <InspectorInput
        label="Slug"
        value={field.slug}
        placeholder={meta.slug}
        mono
        readOnly={readOnly}
        onChange={(v) => onChange({ slug: slugify(v) })}
        help={isPersisted ? 'Avoid renaming — slugs are referenced in filters.' : undefined}
      />

      <InspectorField label="Type">
        <div
          className="inp"
          style={{
            ...inspectorInputStyle,
            display: 'flex',
            alignItems: 'center',
            color: isPersisted ? 'var(--muted)' : 'var(--text)',
            cursor: isPersisted ? 'not-allowed' : 'default',
          }}
        >
          {meta.label}
          <span style={{ flex: 1 }} />
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10.5,
              color: 'var(--dim)',
            }}
          >
            {meta.slug}
          </span>
        </div>
      </InspectorField>

      {meta.hint && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--dim)',
            fontFamily: 'var(--font-mono)',
            padding: '0 2px',
          }}
        >
          {meta.hint}
        </div>
      )}

      {meta.hasOptions && (
        <OptionsEditor
          field={field}
          onChange={onChange}
          readOnly={readOnly}
          allLayouts={allLayouts}
          currentLayoutId={currentLayoutId}
        />
      )}

      <div>
        <ToggleRow
          label="Required"
          value={field.isRequired}
          onChange={(v) => onChange({ isRequired: v })}
          disabled={readOnly}
        />
        <ToggleRow
          label={`Unique per ${lower(term.one)}`}
          value={field.isUniquePerCompany}
          onChange={(v) => onChange({ isUniquePerCompany: v })}
          disabled={readOnly}
        />
        <ToggleRow
          label="Visible to clients"
          value={field.visibleToClients}
          onChange={(v) => onChange({ visibleToClients: v })}
          disabled={readOnly}
        />
        <ToggleRow
          label="Primary (asset name)"
          value={field.isPrimary}
          onChange={(v) => {
            // Only the ON direction is actionable here — a layout must
            // always have exactly one primary, so the current primary's
            // toggle is disabled below. Flipping ON another field's
            // toggle transfers the designation (demoting the old one
            // in the same state update).
            if (v && !field.isPrimary) onMakePrimary(field.key);
          }}
          disabled={readOnly || field.isPrimary}
          help={
            field.isPrimary
              ? 'Primary is locked to this field. Flip another field\u2019s Primary toggle (or click the \u2605 on its row) to move it.'
              : 'Turning this on will demote the current primary.'
          }
        />
        {/* "Show as column in table view" — the per-layout asset table
            renders primary as the first column by default, so it's
            always effectively ON for the primary; non-tabular types
            (RICH_TEXT, FILE) are locked OFF because their cells can't
            be summarised. */}
        {field.isPrimary ? (
          <ToggleRow
            label="Show as column in table view"
            value={true}
            onChange={() => {
              /* locked on for primary */
            }}
            disabled
            help="Always shown as the first column — this is the asset name."
          />
        ) : canShowInTable(field.fieldType) ? (
          <ToggleRow
            label="Show as column in table view"
            value={field.showInTable}
            onChange={(v) => onChange({ showInTable: v })}
            disabled={readOnly}
            help="Adds this field as a column in the per-layout asset table."
          />
        ) : (
          <ToggleRow
            label="Show as column in table view"
            value={false}
            onChange={() => {
              /* locked off for non-tabular types */
            }}
            disabled
            help={`${meta.label} values don\u2019t render cleanly in a table cell.`}
          />
        )}
      </div>
    </aside>
  );
}
