'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LayoutSummary } from '../../../../../../lib/server-api';
import {
  Btn,
  Icon,
  LayoutSwatch,
  Tag,
} from '../../../../../../components/ui';
import { TopBar } from '../../../../../../components/shell/top-bar';
import { AssetForm } from '../asset-form';
import { useTerm } from '../../../../../../lib/term-context';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';

/**
 * Two-phase client orchestrator for "new asset":
 *   1) If no layout chosen → render a palette of global layouts.
 *   2) If chosen → render <AssetForm> and wire up `Change layout`
 *      to come back to step 1.
 * The URL mirrors the chosen layout so a deep link / reload preserves
 * the operator's progress up to the form level.
 */
export function NewAssetFlow({
  companyId,
  companyName,
  layouts,
  initialLayout,
}: {
  companyId: string;
  companyName: string;
  layouts: LayoutSummary[];
  initialLayout: LayoutSummary | null;
}) {
  const router = useRouter();
  const term = useTerm();
  const [chosen, setChosen] = useState<LayoutSummary | null>(initialLayout);

  if (!chosen) {
    return (
      <>
        <TopBar
          crumbs={companyCrumbs(
            term,
            { id: companyId, name: companyName },
            { label: 'Assets', href: `/admin/companies/${companyId}/assets` },
            { label: 'New', mono: true },
          )}
          right={
            <Btn
              kind="outline"
              onClick={() =>
                router.push(`/admin/companies/${companyId}/assets`)
              }
            >
              Cancel
            </Btn>
          }
        />
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            padding: '28px 24px',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <div style={{ width: '100%', maxWidth: 780 }}>
            <h1
              style={{
                fontSize: 20,
                fontWeight: 550,
                margin: '0 0 6px',
                letterSpacing: -0.3,
              }}
            >
              Pick a layout
            </h1>
            <p
              style={{
                margin: '0 0 20px',
                fontSize: 12.5,
                color: 'var(--muted)',
              }}
            >
              Every asset belongs to a global layout — pick the template
              that describes this asset.
            </p>

            {layouts.length === 0 ? (
              <div
                style={{
                  padding: 32,
                  textAlign: 'center',
                  border: '1px dashed var(--line-2)',
                  borderRadius: 6,
                  color: 'var(--muted)',
                  fontSize: 13,
                }}
              >
                No active layouts. Ask a super-admin to create one first.
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 10,
                }}
              >
                {layouts.map((l) => {
                  const activeFields = l.fields.filter((f) => !f.archivedAt);
                  return (
                    <button
                      key={l.id}
                      type="button"
                      onClick={() => {
                        setChosen(l);
                        const sp = new URLSearchParams();
                        sp.set('layout', l.id);
                        router.replace(
                          `/admin/companies/${companyId}/assets/new?${sp.toString()}`,
                        );
                      }}
                      style={{
                        padding: 14,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                        alignItems: 'flex-start',
                        background: 'var(--panel)',
                        border: '1px solid var(--line)',
                        borderRadius: 6,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <LayoutSwatch icon={l.icon} color={l.color} size={28} />
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 550 }}>
                            {l.name}
                          </div>
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 10.5,
                              color: 'var(--dim)',
                              marginTop: 2,
                            }}
                          >
                            /{l.slug}
                          </div>
                        </div>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: 6,
                          alignItems: 'center',
                        }}
                      >
                        <Tag tone="outline">
                          {activeFields.length} field
                          {activeFields.length === 1 ? '' : 's'}
                        </Tag>
                        <Tag tone="outline">v{l.version}</Tag>
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 4,
                          color: 'var(--accent)',
                        }}
                      >
                        use this layout
                        <Icon.chevron size={10} />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <AssetForm
      companyId={companyId}
      companyLabel={companyName}
      layout={chosen}
      mode="create"
      onPickLayout={() => {
        setChosen(null);
        router.replace(`/admin/companies/${companyId}/assets/new`);
      }}
    />
  );
}
