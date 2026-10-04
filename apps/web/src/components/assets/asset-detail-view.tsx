import { Fragment } from 'react';
import type { AssetSummary } from '@weavestream/shared';
import { Panel, Tag } from '../ui';
import { RichTextView } from '../editor/rich-text-view';
import { AssetFieldValue, type AssetFieldContext } from './asset-field-value';

type Field = AssetSummary['fields'][number];

function isNoteField(field: Field): boolean {
  return field.fieldType === 'RICH_TEXT' || field.fieldType === 'TEXTAREA';
}

/**
 * Main column of the asset detail pages (admin + portal): every layout
 * field in a key/value grid, then one panel per RICH_TEXT / TEXTAREA
 * field that holds a value. Headers and the right rail differ per
 * surface and stay in the route files; `context` carries the only
 * render-time difference (link base and mention routing).
 *
 * On phones `.asset-field-grid` stacks each label above its value
 * (`globals.css`), so long values get the full card width.
 */
export function AssetDetailView({
  asset,
  context,
}: {
  asset: Pick<AssetSummary, 'fields' | 'fieldValues' | 'references'>;
  context: AssetFieldContext;
}) {
  const primaryField = asset.fields.find((f) => f.isPrimary);
  const noteFields = asset.fields.filter(isNoteField);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Panel>
        <div
          className="asset-field-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '180px minmax(0, 1fr)',
            gap: '10px 20px',
          }}
        >
          {asset.fields
            .filter((f) => !isNoteField(f))
            .map((f) => (
              <Fragment key={f.id}>
                <div
                  className="asset-field-label"
                  style={{
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    fontFamily: 'var(--font-mono)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.3,
                    paddingTop: 2,
                  }}
                >
                  {f.name}
                  {primaryField?.id === f.id && (
                    <Tag tone="accent" style={{ marginLeft: 6 }}>
                      primary
                    </Tag>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--text)',
                    minWidth: 0,
                    overflowWrap: 'anywhere',
                    wordBreak: 'break-word',
                  }}
                >
                  <AssetFieldValue
                    field={f}
                    value={asset.fieldValues[f.slug]}
                    references={asset.references}
                    context={context}
                  />
                </div>
              </Fragment>
            ))}
        </div>
      </Panel>

      {noteFields.map((noteField) => {
        const value = asset.fieldValues[noteField.slug];
        if (!value) return null;
        return (
          <Panel key={noteField.id} title={noteField.name}>
            {noteField.fieldType === 'RICH_TEXT' ? (
              <RichTextView
                value={value}
                isAdmin={context.richText.isAdmin}
                portalSlugByCompanyId={context.richText.portalSlugByCompanyId}
                fallbackCompanyId={context.richText.fallbackCompanyId}
              />
            ) : (
              <div
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.6,
                  color: 'var(--text-2)',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  wordBreak: 'break-word',
                }}
              >
                {String(value ?? '')}
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}
