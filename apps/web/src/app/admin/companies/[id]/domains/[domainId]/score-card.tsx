'use client';

import { useState } from 'react';
import {
  DataTable,
  type DataColumn,
  MobileCardRow,
  Tag,
  type TagTone,
} from '../../../../../../components/ui';
import type {
  DomainCheck,
  DomainCheckDetails,
  DomainScoreBreakdownItem,
  DomainScoreTier,
} from '../../../../../../lib/server-api';

/**
 * Domain Check v2 — hygiene score card.
 *
 * Renders the percentage score, the human-friendly tier label, an
 * optional delta vs. the prior check, and a collapsible breakdown
 * table that explains *why* the score is what it is. Letter grades
 * are intentionally absent (A-F is US-centric and meaningless to
 * non-US audiences) — we use percentage + tier label everywhere.
 */
export function ScoreCard({
  latest,
  previous,
}: {
  latest: DomainCheck;
  previous: DomainCheck | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const score = latest.details?.score;

  if (!score || latest.score === null) {
    return (
      <UngradedShell schemaVersion={latest.schemaVersion} />
    );
  }

  const tier = score.tier;
  const tone = tierToTone(tier);
  const tierLabel = tierToLabel(tier);
  const percent = score.percent;
  const delta =
    previous?.score !== null && previous?.score !== undefined
      ? percent - previous.score
      : null;
  const breakdown = score.breakdown;
  const summary = summariseBreakdown(breakdown);

  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        overflow: 'hidden',
        // PageBody is a `flex` column with `minHeight: 0` so children
        // can be squeezed when the page outgrows the viewport. Without
        // this the breakdown table gets clipped under `overflow: hidden`
        // when "Why this score?" is expanded.
        flexShrink: 0,
      }}
    >
      <div
        style={{
          padding: 16,
          display: 'grid',
          gridTemplateColumns: 'auto 1fr auto',
          gap: 20,
          alignItems: 'center',
        }}
      >
        <ScoreRing percent={percent} tone={tone} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: 0.6,
              }}
            >
              Hygiene score
            </span>
            <Tag tone={tone}>{tierLabel}</Tag>
            {score.hardOverride && (
              <Tag tone="danger">
                {score.hardOverride.kind === 'force_critical'
                  ? 'critical override'
                  : 'capped at fair'}
              </Tag>
            )}
          </div>
          <div style={{ fontSize: 14, color: 'var(--text)' }}>
            {summary.passed}/{summary.total} checks passing
            {summary.skipped > 0 && (
              <span style={{ color: 'var(--muted)' }}>
                {' '}
                · {summary.skipped} skipped
              </span>
            )}
          </div>
          {delta !== null && (
            <div
              style={{
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                color: delta === 0
                  ? 'var(--muted)'
                  : delta > 0
                    ? 'var(--ok)'
                    : 'var(--danger)',
              }}
            >
              {delta > 0 ? '▲' : delta < 0 ? '▼' : '='}{' '}
              {delta > 0 ? `+${delta}%` : delta === 0 ? '±0%' : `${delta}%`}
              {' '}vs previous check
            </div>
          )}
          {score.hardOverride && (
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--danger)',
                marginTop: 2,
              }}
            >
              {score.hardOverride.reason}
            </div>
          )}
          <div
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              color: 'var(--dim)',
              marginTop: 2,
            }}
          >
            rubric v{score.version} · {score.total}/{score.max} raw points
          </div>
        </div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            background: 'transparent',
            color: 'var(--muted)',
            border: '1px solid var(--line)',
            borderRadius: 5,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Hide breakdown' : 'Why this score?'}
        </button>
      </div>
      {expanded && <BreakdownTable breakdown={breakdown} />}
    </section>
  );
}

function UngradedShell({ schemaVersion }: { schemaVersion: number | null }) {
  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 6,
        padding: 16,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
      }}
    >
      <ScoreRing percent={null} tone="default" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span
          style={{
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            color: 'var(--muted)',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
          }}
        >
          Hygiene score
        </span>
        <div style={{ fontSize: 15, color: 'var(--text)' }}>
          Ungraded
        </div>
        <div style={{ fontSize: 12, color: 'var(--dim)' }}>
          {schemaVersion === null || schemaVersion < 2
            ? 'This check predates the scoring rubric — run a fresh check to score it.'
            : 'No score data available for this check.'}
        </div>
      </div>
    </section>
  );
}

function ScoreRing({
  percent,
  tone,
}: {
  percent: number | null;
  tone: TagTone;
}) {
  const size = 88;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const dash = percent === null ? 0 : (circ * percent) / 100;
  const colorVar = ringColorForTone(tone);
  return (
    <div
      style={{
        position: 'relative',
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ display: 'block' }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth={stroke}
        />
        {percent !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={colorVar}
            strokeWidth={stroke}
            strokeDasharray={`${dash} ${circ - dash}`}
            strokeDashoffset={circ / 4}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dasharray 240ms ease-out' }}
          />
        )}
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
        }}
      >
        <span
          style={{
            fontSize: 22,
            fontWeight: 600,
            color: 'var(--text)',
            fontFamily: 'var(--font-mono)',
            lineHeight: 1,
          }}
        >
          {percent === null ? '—' : `${percent}`}
        </span>
        {percent !== null && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--muted)',
              fontFamily: 'var(--font-mono)',
              marginTop: 2,
            }}
          >
            %
          </span>
        )}
      </div>
    </div>
  );
}

function BreakdownTable({
  breakdown,
}: {
  breakdown: DomainScoreBreakdownItem[];
}) {
  const columns: DataColumn<DomainScoreBreakdownItem>[] = [
    {
      id: 'check',
      header: 'Check',
      width: 220,
      sortValue: (i) => i.label.toLowerCase(),
      render: (i) => <span style={{ color: 'var(--text)' }}>{i.label}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      width: 100,
      sortValue: (i) => statusRank(i.status),
      render: (i) => <StatusChip status={i.status} />,
    },
    {
      id: 'points',
      header: 'Points',
      width: 90,
      mono: true,
      sortValue: (i) => i.points,
      render: (i) => (
        <span style={{ color: 'var(--muted)' }}>
          {i.points}/{i.max}
        </span>
      ),
    },
    {
      id: 'evidence',
      header: 'Evidence',
      sortable: false,
      render: (i) => (
        <span style={{ color: 'var(--muted)' }}>{i.evidence ?? '—'}</span>
      ),
    },
  ];
  return (
    <div style={{ borderTop: '1px solid var(--line)' }}>
      <DataTable
        columns={columns}
        rows={breakdown}
        renderMobileCard={(i) => (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                color: 'var(--text)',
              }}
            >
              <span style={{ flex: 1 }}>{i.label}</span>
              <StatusChip status={i.status} />
            </div>
            <MobileCardRow label="Points" mono>
              {i.points}/{i.max}
            </MobileCardRow>
            {i.evidence && (
              <MobileCardRow label="Evidence">{i.evidence}</MobileCardRow>
            )}
          </div>
        )}
      />
    </div>
  );
}

function StatusChip({
  status,
}: {
  status: DomainScoreBreakdownItem['status'];
}) {
  switch (status) {
    case 'pass':
      return <Tag tone="ok">Pass</Tag>;
    case 'partial':
      return <Tag tone="warn">Partial</Tag>;
    case 'fail':
      return <Tag tone="danger">Fail</Tag>;
    case 'skip':
      return <Tag tone="outline">Skip</Tag>;
  }
}

function statusRank(status: DomainScoreBreakdownItem['status']): number {
  switch (status) {
    case 'fail':
      return 0;
    case 'partial':
      return 1;
    case 'pass':
      return 2;
    case 'skip':
      return 3;
  }
}

function summariseBreakdown(breakdown: DomainScoreBreakdownItem[]) {
  let passed = 0;
  let total = 0;
  let skipped = 0;
  for (const item of breakdown) {
    if (item.status === 'skip') {
      skipped += 1;
      continue;
    }
    total += 1;
    if (item.status === 'pass') passed += 1;
  }
  return { passed, total, skipped };
}

export function tierToTone(tier: DomainScoreTier): TagTone {
  switch (tier) {
    case 'excellent':
    case 'good':
      return 'ok';
    case 'fair':
      return 'warn';
    case 'poor':
    case 'critical':
      return 'danger';
  }
}

export function tierToLabel(tier: DomainScoreTier): string {
  switch (tier) {
    case 'excellent':
      return 'Excellent';
    case 'good':
      return 'Good';
    case 'fair':
      return 'Fair';
    case 'poor':
      return 'Poor';
    case 'critical':
      return 'Critical';
  }
}

export function percentToTier(percent: number): DomainScoreTier {
  if (percent >= 90) return 'excellent';
  if (percent >= 75) return 'good';
  if (percent >= 55) return 'fair';
  if (percent >= 35) return 'poor';
  return 'critical';
}

function ringColorForTone(tone: TagTone): string {
  // Use the same CSS custom properties that the Tag tones reference.
  switch (tone) {
    case 'ok':
      return 'var(--ok)';
    case 'warn':
      return 'var(--warn)';
    case 'danger':
      return 'var(--danger)';
    case 'accent':
      return 'var(--accent)';
    default:
      return 'var(--line-2)';
  }
}

// Suppress unused-export warnings for helpers consumed by the alerts
// panel + history table.
export type { DomainCheckDetails };
