'use client';

import type { CloudflareIpListDto } from '@weavestream/shared';
import { Btn, Icon, Tag } from '../ui';

/**
 * Banner that surfaces drift between Weavestream and Cloudflare for a
 * single registered list. Weavestream is the authoritative source, so
 * the periodic drift sweep self-heals any discrepancy by re-pushing the
 * local entries on the next cron tick. This banner therefore has three
 * modes:
 *
 *   - in_sync (no banner) — optionally a subtle "auto-recovered N min ago"
 *     note when the last sweep healed drift.
 *   - drift_detected — only ever visible when self-heal failed (e.g. CF
 *     unreachable mid-sweep). Includes a manual "Overwrite Cloudflare"
 *     button so the operator can retry without waiting for the next tick.
 *   - error — drift check itself errored (auth / network).
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
  const lastSelfHeal = list.driftDetails?.lastSelfHeal ?? null;

  if (list.driftStatus === 'unknown') return null;

  if (list.driftStatus === 'in_sync') {
    if (!lastSelfHeal) return null;
    const diff = Date.now() - new Date(lastSelfHeal.at).getTime();
    if (diff > 15 * 60_000) return null;
    const parts: string[] = [];
    if (lastSelfHeal.pushed > 0) {
      parts.push(
        `re-added ${lastSelfHeal.pushed} entr${lastSelfHeal.pushed === 1 ? 'y' : 'ies'} to Cloudflare`,
      );
    }
    if (lastSelfHeal.removed > 0) {
      parts.push(
        `removed ${lastSelfHeal.removed} unauthorised entr${lastSelfHeal.removed === 1 ? 'y' : 'ies'} from Cloudflare`,
      );
    }
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          border: '1px solid var(--line)',
          background: 'var(--panel-2)',
          borderRadius: 6,
        }}
      >
        <Tag tone="ok" dot>
          auto-recovered
        </Tag>
        <span style={{ fontSize: 13, color: 'var(--text-2)', flex: 1 }}>
          {parts.length === 0
            ? 'Drift sweep self-healed a discrepancy.'
            : `Drift sweep ${parts.join(' and ')}.`}{' '}
          <span style={{ color: 'var(--muted)' }}>{relative(lastSelfHeal.at)}</span>
        </span>
      </div>
    );
  }

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
  const healFailed = (list.driftDetails?.lastError ?? '').startsWith(
    'Auto-heal failed',
  );

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
        <Tag tone={healFailed ? 'danger' : 'warn'} dot>
          {healFailed ? 'auto-heal failed' : 'drift detected'}
        </Tag>
        <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>
          {summary.length === 0
            ? 'Cloudflare and Weavestream do not match.'
            : `${summary.join(' · ')}.`}
          {healFailed
            ? ' Auto-recovery will retry on the next sweep — use the button to retry now.'
            : ' Auto-recovery will run on the next sweep.'}
        </span>
        <Btn
          kind="primary"
          size="sm"
          icon={Icon.sync}
          onClick={onOverwrite}
          loading={overwriting}
        >
          Overwrite Cloudflare now
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

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
