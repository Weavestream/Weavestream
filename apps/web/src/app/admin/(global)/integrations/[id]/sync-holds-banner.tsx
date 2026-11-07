'use client';

import type { IntegrationSyncHoldDto } from '@weavestream/shared';
import { ErrorBanner } from '../../../../../components/ui';
import { FormattedDateTime } from '../../../../../lib/timezone-context';

const KIND_LABEL: Record<IntegrationSyncHoldDto['kind'], string> = {
  removal: 'Records missing',
  field: 'Field no longer sent',
  version: 'Unknown source version',
};

/**
 * Sync holds of this integration: Weavestream stopped writing or archiving
 * because the source changed in a way that could lose synced data. One row
 * per held (company, resource) and kind; the rows wrap on narrow screens.
 * Nothing renders when there is no hold.
 */
export function SyncHoldsBanner({
  holds,
  sourceLabel,
}: {
  holds: IntegrationSyncHoldDto[];
  sourceLabel: string;
}) {
  if (holds.length === 0) return null;
  return (
    <ErrorBanner
      tone="warn"
      title={`Sync is on hold: ${sourceLabel} changed in a way that could remove or blank synced records.`}
    >
      <ul style={listStyle}>
        {holds.map((hold) => (
          <li key={`${hold.kind}:${hold.resourceKey}:${hold.companyId}`} style={itemStyle}>
            <strong style={{ fontWeight: 600 }}>{hold.resourceLabel}</strong>
            <span style={{ color: 'var(--muted)' }}>{hold.companyName ?? 'Unknown company'}</span>
            <span>
              {KIND_LABEL[hold.kind]}: <span style={detailStyle}>{hold.detail}</span>
            </span>
            {hold.since && (
              <span style={{ color: 'var(--muted)' }}>
                since <FormattedDateTime value={hold.since} />
              </span>
            )}
          </li>
        ))}
      </ul>
      <p style={helpStyle}>
        Nothing was archived or changed for these records.
        {holds.some((hold) => hold.kind === 'version') && (
          <>
            {' '}A paused resource reads nothing from {sourceLabel} until Weavestream knows the new
            version or an admin accepts it.
          </>
        )}{' '}
        Check the change in {sourceLabel}.
        If it is expected, select <strong>Accept changes from {sourceLabel}</strong> next to{' '}
        <strong>Run sync now</strong> on the Credentials &amp; schedule tab.
      </p>
    </ErrorBanner>
  );
}

const listStyle = {
  margin: 0,
  padding: 0,
  listStyle: 'none',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
} as const;

const itemStyle = {
  display: 'flex',
  flexWrap: 'wrap',
  columnGap: 10,
  rowGap: 2,
  fontSize: 12.5,
  minWidth: 0,
} as const;

const detailStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11.5,
  wordBreak: 'break-word',
} as const;

const helpStyle = {
  margin: '8px 0 0',
  fontSize: 12.5,
  color: 'var(--muted)',
} as const;
