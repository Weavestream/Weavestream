'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { problemMessage, type IntegrationDifferenceChoice, type IntegrationDifferenceDto } from '@weavestream/shared';
import { apiFetch } from '../../lib/api';
import { Btn, useToast } from '../ui';

/** POST one resolution; returns an error message, or null when it worked. */
export async function resolveDifference(
  companyId: string,
  assetId: string,
  difference: Pick<IntegrationDifferenceDto, 'syncRecordId' | 'assetFieldId'>,
  choice: IntegrationDifferenceChoice,
): Promise<string | null> {
  try {
    const res = await apiFetch(`/companies/${companyId}/assets/${assetId}/integration-differences/resolve`, {
      method: 'POST',
      body: JSON.stringify({ syncRecordId: difference.syncRecordId, assetFieldId: difference.assetFieldId, choice }),
    });
    return res.ok ? null : problemMessage(res.problem) ?? 'Could not resolve the difference.';
  } catch {
    return 'Could not resolve the difference. Check your connection and try again.';
  }
}

/** The two actions for one difference, shared by the asset page and the integration's Differences tab. */
export function DifferenceActions({
  companyId,
  assetId,
  difference,
  sourceLabel,
  onResolved,
}: {
  companyId: string;
  assetId: string;
  difference: IntegrationDifferenceDto;
  sourceLabel: string;
  /** Called after a resolution; default refreshes the server-rendered page. */
  onResolved?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, setPending] = useState<IntegrationDifferenceChoice | null>(null);
  async function act(choice: IntegrationDifferenceChoice) {
    setPending(choice);
    const error = await resolveDifference(companyId, assetId, difference, choice);
    setPending(null);
    if (error) {
      toast.push(error, 'danger');
      return;
    }
    toast.push(choice === 'source' ? `${difference.fieldLabel} now uses the ${sourceLabel} value.` : `Kept the Weavestream value of ${difference.fieldLabel}.`, 'ok');
    if (onResolved) onResolved();
    else router.refresh();
  }
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}>
      <Btn size="sm" kind="primary" loading={pending === 'source'} disabled={pending !== null} onClick={() => act('source')}>
        {`Use ${sourceLabel} value`}
      </Btn>
      <Btn size="sm" loading={pending === 'local'} disabled={pending !== null} onClick={() => act('local')}>
        Keep ours
      </Btn>
    </span>
  );
}

const muted = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10.5,
  textTransform: 'uppercase' as const,
  letterSpacing: 0.4,
  color: 'var(--muted)',
};

/**
 * Bottom group of an integration panel on the asset page: standard fields a
 * person changed that now differ from the source. Buttons only for viewers
 * who can write the asset.
 */
export function IntegrationDifferences({
  companyId,
  assetId,
  sourceLabel,
  differences,
  canResolve,
}: {
  companyId: string;
  assetId: string;
  sourceLabel: string;
  differences: IntegrationDifferenceDto[];
  canResolve: boolean;
}) {
  if (differences.length === 0) return null;
  return (
    <div
      aria-label="Differences"
      role="group"
      style={{
        gridColumn: '1 / -1',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
        background: 'var(--panel-2)',
        minWidth: 0,
      }}
    >
      <div style={{ ...muted, fontSize: 11, padding: '6px 10px', borderBottom: '1px solid var(--line)', letterSpacing: 0.6 }}>
        Differences
      </div>
      <p style={{ margin: 0, padding: '6px 10px 0', fontSize: 12, color: 'var(--muted)' }}>
        These fields were changed in Weavestream and now differ from {sourceLabel}. Syncs leave them alone until you choose.
      </p>
      <div style={{ padding: '2px 10px' }}>
        {differences.map((difference, index) => (
          <div
            key={difference.assetFieldId}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 12,
              padding: '8px 0',
              borderBottom: index === differences.length - 1 ? 'none' : '1px solid var(--line)',
              fontSize: 12,
            }}
          >
            <span style={{ flex: '1 1 120px', minWidth: 0, fontWeight: 600, color: 'var(--text)' }}>{difference.fieldLabel}</span>
            <span style={{ flex: '2 1 160px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={muted}>Weavestream</span>
              <span style={{ overflowWrap: 'anywhere', color: 'var(--text-2)' }}>{difference.localValue ?? 'empty'}</span>
            </span>
            <span style={{ flex: '2 1 160px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={muted}>{sourceLabel}</span>
              <span style={{ overflowWrap: 'anywhere', color: 'var(--text-2)' }}>{difference.sourceValue ?? 'empty'}</span>
            </span>
            {canResolve && (
              <DifferenceActions companyId={companyId} assetId={assetId} difference={difference} sourceLabel={sourceLabel} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
