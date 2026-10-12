import type { ReactNode } from 'react';
import {
  formatCalendarDate,
  humanSize,
  type AssetIntegrationSection,
  type IntegrationSectionRow,
} from '@weavestream/shared';
import { Icon, Tag, type TagTone } from '../ui';
import { ExternalUrlValue } from '../assets/external-url-value';
import { FormattedDateTime } from '../../lib/timezone-context';
import { recentRelative } from '../../lib/relative-time';
import { IntegrationDifferences } from './integration-differences';

/**
 * Driver-supplied integration sections on the asset page (one collapsible
 * panel per binding, modelled on integration cards). The data is
 * schema-validated plain text; everything here renders as text nodes.
 */
export function IntegrationSections({
  sections,
  companyId,
  assetId,
  canResolve = false,
}: {
  sections: AssetIntegrationSection[];
  /** With `assetId`: the asset the panels belong to, for resolving differences. */
  companyId?: string;
  assetId?: string;
  /** The viewer can write the asset: show the difference buttons. */
  canResolve?: boolean;
}) {
  if (sections.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sections.map((entry, index) => (
        <IntegrationSectionPanel
          key={`${entry.integrationId}:${index}`}
          entry={entry}
          differences={
            companyId && assetId ? (
              <IntegrationDifferences
                companyId={companyId}
                assetId={assetId}
                sourceLabel={entry.section.title}
                differences={entry.differences ?? []}
                canResolve={canResolve}
              />
            ) : null
          }
        />
      ))}
    </div>
  );
}

const DRIVER_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

function IconImg({ src, size }: { src: string | null; size: number }) {
  if (!src) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- local public SVG icons; next/image SVG needs config
    <img src={src} alt="" width={size} height={size} style={{ flexShrink: 0, display: 'block' }} />
  );
}

function IntegrationSectionPanel({ entry, differences }: { entry: AssetIntegrationSection; differences: ReactNode }) {
  const { section } = entry;
  const logo = section.icon
    ? `/integrations/icons/${section.icon}.svg`
    : DRIVER_KEY_RE.test(entry.driver)
      ? `/integrations/drivers/${entry.driver}.svg`
      : null;
  return (
    <section
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-card)',
      }}
    >
      <details open className="integration-section">
        <summary
          style={{
            minHeight: 34,
            padding: '6px 12px',
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            cursor: 'pointer',
            listStyle: 'none',
          }}
        >
          <Icon.chevron size={10} className="integration-section-chevron" />
          <IconImg src={logo} size={16} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', flex: 1, minWidth: 0 }}>
            {section.title}
          </span>
          {entry.active === false && <Tag tone="warn">No longer in {entry.integrationName}</Tag>}
          <span
            title={`${entry.integrationName} · last synced ${new Date(entry.lastSyncedAt).toISOString()}`}
            style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--muted)' }}
          >
            synced {recentRelative(new Date(entry.lastSyncedAt))}
          </span>
        </summary>
        <div
          style={{
            borderTop: '1px solid var(--line)',
            padding: 12,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
            gap: 12,
          }}
        >
          {section.groups.map((group) => (
            <div
              key={group.key}
              style={{
                border: '1px solid var(--line)',
                borderRadius: 'var(--radius-card)',
                background: 'var(--panel-2)',
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  borderBottom: '1px solid var(--line)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                }}
              >
                <IconImg src={group.icon ? `/integrations/icons/${group.icon}.svg` : null} size={14} />
                <span>{group.title}</span>
              </div>
              <div style={{ padding: '2px 10px' }}>
                {group.rows.map((row, index) => (
                  <SectionRow key={index} row={row} last={index === group.rows.length - 1} />
                ))}
              </div>
            </div>
          ))}
          {differences}
        </div>
      </details>
    </section>
  );
}

function SectionRow({ row, last }: { row: IntegrationSectionRow; last: boolean }) {
  const meter = row.kind === 'meter';
  // Meters and lists take the full card width under their label: list items
  // are free text (update names, alerts) that must wrap inside the card.
  const stacked = meter || row.kind === 'list';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: stacked ? 'column' : 'row',
        flexWrap: 'wrap',
        alignItems: stacked ? 'stretch' : 'baseline',
        gap: stacked ? 4 : 8,
        padding: '6px 0',
        borderBottom: last ? 'none' : '1px solid var(--line)',
        fontSize: 12,
      }}
    >
      <span
        style={{
          flex: stacked ? undefined : '1 1 100px',
          minWidth: 0,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          fontSize: 10.5,
        }}
      >
        {row.label}
      </span>
      <span style={{ color: 'var(--text-2)', minWidth: 0, overflowWrap: 'anywhere', textAlign: stacked ? 'left' : 'right' }}>
        {renderValue(row)}
      </span>
    </div>
  );
}

const BADGE_TONES: Record<NonNullable<Extract<IntegrationSectionRow, { kind: 'badge' }>['tone']>, TagTone> = {
  neutral: 'default',
  success: 'ok',
  warning: 'warn',
  danger: 'danger',
};

const LIST_VISIBLE = 6;

function renderValue(row: IntegrationSectionRow): ReactNode {
  switch (row.kind) {
    case 'text':
      return row.value;
    case 'number':
      return row.value.toLocaleString('en-US');
    case 'bytes':
      return humanSize(row.value);
    case 'date':
      return formatCalendarDate(row.value);
    case 'datetime':
      return <FormattedDateTime value={row.value} />;
    case 'boolean':
      return <Tag tone={row.value ? 'ok' : 'default'}>{row.value ? 'yes' : 'no'}</Tag>;
    case 'badge':
      return <Tag tone={BADGE_TONES[row.tone ?? 'neutral']}>{row.value}</Tag>;
    case 'link':
      return <ExternalUrlValue url={row.value} label={row.text} />;
    case 'list': {
      if (row.value.length === 0) return <span style={{ color: 'var(--dim)' }}>none</span>;
      const hidden = row.value.length - LIST_VISIBLE;
      return (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {row.value.slice(0, LIST_VISIBLE).map((item, index) => (
            <li
              key={index}
              style={{ padding: '3px 8px', borderRadius: 4, background: 'var(--panel-2)', border: '1px solid var(--line)', overflowWrap: 'anywhere' }}
            >
              {item}
            </li>
          ))}
          {hidden > 0 && (
            <li title={row.value.slice(LIST_VISIBLE).join(', ')} style={{ color: 'var(--muted)' }}>
              +{hidden} more
            </li>
          )}
        </ul>
      );
    }
    case 'meter':
      return <UsageMeter row={row} />;
  }
}

/** Display text for one meter amount in its unit. */
function meterAmount(value: number, unit: 'bytes' | 'mb' | 'count'): string {
  if (unit === 'bytes') return humanSize(value);
  if (unit === 'mb') return humanSize(value * 1024 * 1024);
  return value.toLocaleString('en-US');
}

/**
 * Rounded percent plus the threshold tone. Usage meters: amber at 80%,
 * red at 95%. Coverage meters (higherIsBetter): red below 50%, amber
 * below 80%, otherwise ok.
 */
export function meterState(
  used: number,
  total: number,
  higherIsBetter = false,
): { percent: number; tone: 'ok' | 'warn' | 'danger' } {
  const percent = Math.round((used / total) * 100);
  if (higherIsBetter) return { percent, tone: percent < 50 ? 'danger' : percent < 80 ? 'warn' : 'ok' };
  return { percent, tone: percent >= 95 ? 'danger' : percent >= 80 ? 'warn' : 'ok' };
}

function UsageMeter({ row }: { row: Extract<IntegrationSectionRow, { kind: 'meter' }> }) {
  const { percent, tone } = meterState(row.used, row.total, row.higherIsBetter);
  const text = `${meterAmount(row.used, row.unit)} of ${meterAmount(row.total, row.unit)} (${percent}%)`;
  const fill = tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span
        role="meter"
        aria-label={row.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(percent, 100)}
        aria-valuetext={text}
        data-tone={tone}
        style={{
          display: 'block',
          height: 6,
          borderRadius: 3,
          background: 'var(--line)',
          overflow: 'hidden',
        }}
      >
        <span style={{ display: 'block', height: '100%', width: `${Math.min(percent, 100)}%`, background: fill }} />
      </span>
      <span style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: tone === 'ok' ? 'var(--text-2)' : fill }}>
        {row.value ? `${row.value} · ` : ''}
        {text}
      </span>
    </span>
  );
}
