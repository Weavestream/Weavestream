'use client';

import type { LayoutSummary } from '@weavestream/shared';
import { ChoicesEditor } from './choices-editor';
import {
  InspectorField,
  InspectorInput,
  ToggleRow,
  inspectorInputStyle,
} from './inspector-controls';
import type { BuilderField } from './types';

export function OptionsEditor({
  field,
  onChange,
  readOnly,
  allLayouts,
  currentLayoutId,
}: {
  field: BuilderField;
  onChange: (patch: Partial<BuilderField>) => void;
  readOnly: boolean;
  allLayouts: LayoutSummary[];
  currentLayoutId: string;
}) {
  switch (field.fieldType) {
    case 'DROPDOWN':
    case 'MULTISELECT':
      return (
        <ChoicesEditor
          options={field.options}
          onChange={(opts) => onChange({ options: opts })}
          readOnly={readOnly}
          allowAllowOther={field.fieldType === 'DROPDOWN'}
          allowMax={field.fieldType === 'MULTISELECT'}
        />
      );
    case 'DATE':
    case 'DATETIME':
      return (
        <InspectorField label="Options">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ToggleRow
              label="Treat as expiry"
              value={!!field.options.isExpiry}
              onChange={(v) =>
                onChange({
                  options: { ...field.options, isExpiry: v },
                })
              }
              disabled={readOnly}
              help="Drives warranty countdown chips in lists + detail."
            />
            <InspectorInput
              label="Warn within (days)"
              value={String(field.options.warnWithinDays ?? '')}
              mono
              readOnly={readOnly}
              onChange={(v) => {
                const n = parseInt(v || '0', 10);
                const { warnWithinDays: _unused, ...rest } = field.options as Record<
                  string,
                  unknown
                >;
                void _unused;
                onChange({
                  options: {
                    ...rest,
                    ...(Number.isFinite(n) && n > 0 ? { warnWithinDays: n } : {}),
                  },
                });
              }}
            />
          </div>
        </InspectorField>
      );
    case 'ASSET_REFERENCE': {
      const currentTargetId = String(
        (field.options as { targetLayoutId?: string }).targetLayoutId ?? '',
      );
      // Surface all non-archived layouts, sorted by name for quick scanning.
      // The current layout is still included — self-reference is a valid
      // modeling choice (e.g. parent/child relationships on the same kind).
      // If the persisted target points to an archived layout we inject a
      // disabled row so the operator can see what they have without us
      // silently losing the value.
      const selectable = allLayouts
        .filter((l) => !l.archivedAt)
        .sort((a, b) => a.name.localeCompare(b.name));
      const persistedMissing =
        currentTargetId &&
        !selectable.some((l) => l.id === currentTargetId)
          ? allLayouts.find((l) => l.id === currentTargetId)
          : undefined;
      return (
        <InspectorField
          label="Reference target"
          hint="Pick the layout that assets of this field will point at."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <InspectorField label="Target layout">
              <select
                value={currentTargetId}
                disabled={readOnly}
                onChange={(e) =>
                  onChange({
                    options: {
                      ...field.options,
                      targetLayoutId: e.target.value,
                    },
                  })
                }
                className="inp"
                style={inspectorInputStyle}
              >
                <option value="">— Select a layout —</option>
                {selectable.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.id === currentLayoutId ? ' (this layout)' : ''}
                  </option>
                ))}
                {persistedMissing && (
                  <option value={persistedMissing.id}>
                    {persistedMissing.name} (archived)
                  </option>
                )}
              </select>
            </InspectorField>
            <InspectorInput
              label="Relation verb"
              value={String((field.options as { relationType?: string }).relationType ?? '')}
              mono
              readOnly={readOnly}
              onChange={(v) =>
                onChange({
                  options: { ...field.options, relationType: v.trim() || undefined },
                })
              }
              help="Defaults to the field slug if blank."
            />
            <ToggleRow
              label="Allow multiple targets"
              value={!!(field.options as { multiple?: boolean }).multiple}
              onChange={(v) =>
                onChange({
                  options: { ...field.options, multiple: v },
                })
              }
              disabled={readOnly}
            />
          </div>
        </InspectorField>
      );
    }
    case 'IP_ADDRESS':
      return (
        <InspectorField
          label="IP options"
          hint="Restrict the accepted family and decide whether CIDR suffixes (e.g. /24) are allowed."
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <InspectorField label="Version">
              <select
                value={
                  (field.options as { version?: 'v4' | 'v6' | 'any' }).version ??
                  'any'
                }
                disabled={readOnly}
                onChange={(e) =>
                  onChange({
                    options: {
                      ...field.options,
                      version: e.target.value as 'v4' | 'v6' | 'any',
                    },
                  })
                }
                className="inp"
                style={inspectorInputStyle}
              >
                <option value="any">Any (IPv4 or IPv6)</option>
                <option value="v4">IPv4 only</option>
                <option value="v6">IPv6 only</option>
              </select>
            </InspectorField>
            <ToggleRow
              label="Allow CIDR suffix"
              value={!!(field.options as { allowCidr?: boolean }).allowCidr}
              onChange={(v) =>
                onChange({ options: { ...field.options, allowCidr: v } })
              }
              disabled={readOnly}
              help="Enables subnet entries like 10.0.0.0/24 alongside host addresses."
            />
          </div>
        </InspectorField>
      );
    case 'FILE':
      return (
        <InspectorField label="Upload">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <InspectorInput
              label="Max size (MB)"
              value={String((field.options as { maxSizeMb?: number }).maxSizeMb ?? 25)}
              mono
              readOnly={readOnly}
              onChange={(v) => {
                const n = parseInt(v || '0', 10);
                onChange({
                  options: {
                    ...field.options,
                    maxSizeMb: Number.isFinite(n) && n > 0 ? n : 25,
                  },
                });
              }}
            />
            <ToggleRow
              label="Allow multiple files"
              value={!!(field.options as { multiple?: boolean }).multiple}
              onChange={(v) =>
                onChange({
                  options: { ...field.options, multiple: v },
                })
              }
              disabled={readOnly}
            />
          </div>
        </InspectorField>
      );
    default:
      return null;
  }
}
