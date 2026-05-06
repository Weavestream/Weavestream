'use client';

import type { CloudflareIpListDto } from '@weavestream/shared';
import { Btn, Icon, Tag } from '../ui';

/**
 * Banner that surfaces drift between Weavestream and Cloudflare for a
 * single registered list. Visible whenever Cloudflare's view differs
 * from Weavestream's; clicking "Overwrite Cloudflare" PATCHes the
 * Gateway list synchronously to match Weavestream's view. The diff
 * summary is read from `list.driftDetails` populated by the periodic
 * sweep or a manual "Check now" call.
 */
export function DriftBanner({
  list,
  onOverwrite,
  overwriting,
}: {
  list: CloudflareIpListDto;
  onOverwrite: () => void;
  overwriting: boolean;
}) {
  if (list.driftStatus === 'in_sync' || list.driftStatus === 'unknown') return null;

  if (list.driftStatus === 'error') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 14px',
          border: '1px solid var(--danger-line, var(--line))',
          background: 'var(--danger-soft)',
          borderRadius: 6,
        }}
      >
        <Tag tone="danger" dot>
          drift check error
        </Tag>
        <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>
          {list.driftDetails?.lastError ??
            'The last drift check failed. Cloudflare may be unreachable or the API token may have changed.'}
        </span>
      </div>
    );
  }

  const missing = list.driftDetails?.missingOnCf ?? [];
  const extra = list.driftDetails?.extraOnCf ?? [];
  const summary: string[] = [];
  if (missing.length > 0) {
    summary.push(
      `${missing.length} entr${missing.length === 1 ? 'y is' : 'ies are'} missing from Cloudflare`,
    );
  }
  if (extra.length > 0) {
    summary.push(
      `${extra.length} entr${extra.length === 1 ? 'y was' : 'ies were'} added directly in Cloudflare`,
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '12px 14px',
        border: '1px solid var(--warn-line, var(--line))',
        background: 'var(--warn-soft)',
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Tag tone="warn" dot>
          drift detected
        </Tag>
        <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>
          {summary.length === 0
            ? 'Cloudflare and Weavestream do not match.'
            : summary.join(' · ')}
          .
        </span>
        <Btn
          kind="primary"
          size="sm"
          icon={Icon.sync}
          onClick={onOverwrite}
          loading={overwriting}
        >
          Overwrite Cloudflare
        </Btn>
      </div>
      {extra.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            paddingTop: 6,
            borderTop: '1px dashed var(--line)',
          }}
        >
          {extra.slice(0, 8).map((e) => (
            <Tag key={e.ip} tone="outline">
              {e.ip}
            </Tag>
          ))}
          {extra.length > 8 && (
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              + {extra.length - 8} more
            </span>
          )}
        </div>
      )}
    </div>
  );
}
