'use client';

import {
  FIELD_TYPE_CATALOG,
  type LayoutFieldSummary,
  type LayoutStats,
  type LayoutSummary,
} from '@weavestream/shared';
import { lower } from '../../../../../../../lib/term';
import { useTerm } from '../../../../../../../lib/term-context';
import { Icon, LayoutSwatch, Tag } from '../../../../../../../components/ui';
import { PageHeader } from '../../../../../../../components/shell/page-header';

/**
 * Phone-width fallback. The builder is drag-and-drop and needs a
 * desktop viewport, so narrow screens get a read-only list of the
 * persisted fields instead.
 */
export function MobileLayoutPreview({
  layout,
  stats,
  activeFields,
}: {
  layout: LayoutSummary;
  stats: LayoutStats | null;
  activeFields: readonly LayoutFieldSummary[];
}) {
  const term = useTerm();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <PageHeader
        crumbs={[
          { label: 'Layouts', href: '/admin/layouts' },
          { label: layout.name },
          { label: 'edit', mono: true },
        ]}
        leading={
          <LayoutSwatch icon={layout.icon} color={layout.color} size={48} />
        }
        title={layout.name}
        description={
          <>
            v{layout.version} · {activeFields.length} field
            {activeFields.length === 1 ? '' : 's'}
            {stats &&
              ` · used by ${stats.assetCount} asset${stats.assetCount === 1 ? '' : 's'} in ${stats.companyCount} ${
                stats.companyCount === 1 ? lower(term.one) : lower(term.other)
              }`}
          </>
        }
        actions={<Tag tone="outline">read only</Tag>}
      />
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '16px 16px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            background: 'var(--warn-soft, var(--panel))',
            border: '1px solid var(--warn-line, var(--line))',
            borderRadius: 8,
            color: 'var(--text)',
            fontSize: 13,
          }}
        >
          <Icon.warn size={16} style={{ flexShrink: 0, color: 'var(--warn, var(--muted))' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <strong style={{ fontSize: 13, fontWeight: 600 }}>
              Best viewed on a larger screen
            </strong>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              The layout builder is drag-and-drop and needs a desktop viewport.
              A read-only preview of the current fields is below.
            </span>
          </div>
        </div>

        {activeFields.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
              border: '1px dashed var(--line)',
              borderRadius: 8,
            }}
          >
            No fields defined yet.
          </div>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {activeFields.map((f) => {
              const meta = FIELD_TYPE_CATALOG.find((m) => m.kind === f.fieldType);
              return (
                <li
                  key={f.id}
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 8,
                    padding: 12,
                    background: 'var(--panel)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>
                      {f.name}
                    </span>
                    {f.isPrimary && <Tag tone="accent">primary</Tag>}
                    {f.isRequired && <Tag tone="warn">required</Tag>}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: 'var(--dim)',
                    }}
                  >
                    /{f.slug} · {meta?.label ?? f.fieldType}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {f.isUniquePerCompany && <Tag tone="outline">unique</Tag>}
                    {!f.visibleToClients && <Tag tone="outline">internal</Tag>}
                    {f.showInTable && <Tag tone="outline">in table</Tag>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {/* Trailing inset: this div is the scroll container, and a
            scroll container's block-end padding never reaches the
            scrollable overflow region, so the last field card would
            sit flush on the bottom edge. `marginTop` cancels the
            flex gap. See the same note in `PageBody`. */}
        <div
          aria-hidden
          style={{ height: 16, flex: '0 0 auto', marginTop: -16 }}
        />
      </div>
    </div>
  );
}
