'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  DriverDescriptor,
  IntegrationCompanyMappingDto,
  IntegrationDto,
} from '@weavestream/shared';
import { Btn, Icon, Tag } from '../../../../../components/ui';
import { CreateMappingDialog } from './create-mapping-dialog';
import { MappingDetailDialog } from './mapping-detail-dialog';

/**
 * Phase 11 — organizations tab.
 *
 * Lists every `IntegrationCompanyMapping` for this integration. Each
 * row links the upstream org → Weavestream company. Layout, match
 * keys, and field mappings are configured GLOBALLY on the integration
 * (see the "Field mappings" tab); per-row config here is limited to
 * enable/disable + delete. Manual run controls live on the
 * "Credentials & schedule" tab.
 */
export function OrgsTab({
  integration,
  mappings,
  driver,
}: {
  integration: IntegrationDto;
  mappings: IntegrationCompanyMappingDto[];
  driver: DriverDescriptor | null;
}) {
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<IntegrationCompanyMappingDto | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <h3
            style={{
              margin: 0,
              fontFamily: 'var(--font-display)',
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: -0.2,
            }}
          >
            Organizations
          </h3>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--muted)' }}>
            Map each upstream organization to a Weavestream company.
            Field mappings, match keys, and target layout are
            configured globally on the “Field mappings” tab.
          </p>
        </div>
        <Btn
          kind="primary"
          size="sm"
          icon={Icon.plus}
          onClick={() => setCreateOpen(true)}
          disabled={!integration.hasSecret}
        >
          Add mapping
        </Btn>
      </header>

      {!integration.hasSecret && (
        <Tag tone="warn">
          Add credentials in the “Credentials &amp; schedule” tab before mapping organizations.
        </Tag>
      )}
      {integration.hasSecret && !integration.assetLayoutId && (
        <Tag tone="warn">
          No global field mappings yet — open the “Field mappings” tab
          to pick a layout and project upstream fields. Syncs are blocked
          until at least one field mapping exists.
        </Tag>
      )}

      {mappings.length === 0 ? (
        <div
          style={{
            padding: 32,
            border: '1px dashed var(--line-2)',
            borderRadius: 8,
            color: 'var(--muted)',
            textAlign: 'center',
            fontSize: 13,
          }}
        >
          No company mappings yet. Add one to start syncing data into a
          Weavestream company.
        </div>
      ) : (
        <div
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          {mappings.map((m, idx) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setEditing(m)}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                background: 'transparent',
                border: 'none',
                borderTop: idx === 0 ? 'none' : '1px solid var(--line)',
                cursor: 'pointer',
                textAlign: 'left',
                color: 'var(--text)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <strong style={{ fontSize: 13 }}>
                    {m.externalOrgName ?? m.externalOrgId}
                  </strong>
                  <Icon.chevron size={10} style={{ color: 'var(--dim)' }} />
                  <strong style={{ fontSize: 13 }}>
                    {m.companyName ?? m.companyId.slice(0, 8)}
                  </strong>
                  {!m.enabled && (
                    <Tag tone="warn" dot>
                      paused
                    </Tag>
                  )}
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    fontSize: 11.5,
                    color: 'var(--dim)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  <span>org id: {m.externalOrgId}</span>
                  <span>company id: {m.companyId.slice(0, 8)}…</span>
                </div>
              </div>
              <Icon.chevron size={12} style={{ color: 'var(--dim)' }} />
            </button>
          ))}
        </div>
      )}

      {createOpen && (
        <CreateMappingDialog
          integrationId={integration.id}
          driver={driver}
          hasGlobalLayout={Boolean(integration.assetLayoutId)}
          existingExternalOrgIds={mappings.map((m) => m.externalOrgId)}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            router.refresh();
          }}
        />
      )}

      {editing && (
        <MappingDetailDialog
          integration={integration}
          mapping={editing}
          onClose={() => setEditing(null)}
          onChanged={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
