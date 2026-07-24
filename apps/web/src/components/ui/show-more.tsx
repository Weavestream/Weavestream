'use client';

import { useState, type ReactNode } from 'react';
import { Icon } from './icon';

/**
 * Minimal text disclosure for secondary detail-page content (system
 * metadata like activity history and sync provenance). Renders nothing
 * but a muted mono text toggle until expanded; primary panels (linked
 * items, credentials, attachments) must never go inside one.
 */
export function ShowMore({
  children,
  moreLabel = 'show more',
  lessLabel = 'show less',
  attention,
}: {
  children: ReactNode;
  moreLabel?: string;
  lessLabel?: string;
  /**
   * Signal that the hidden content needs review (e.g. a stale or
   * blocked source record) with a small tone dot next to the collapsed
   * label, so collapsing never buries an anomaly entirely.
   */
  attention?: 'warn' | 'danger';
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          alignSelf: 'flex-start',
          fontSize: 11.5,
          color: 'var(--muted)',
          fontFamily: 'var(--font-mono)',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      >
        <Icon.chevron
          size={10}
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        />
        {open ? lessLabel : moreLabel}
        {!open && attention && (
          <span
            role="img"
            aria-label="attention needed"
            title="Hidden details need attention"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background:
                attention === 'danger' ? 'var(--danger)' : 'var(--warn)',
            }}
          />
        )}
      </button>
      {open && children}
    </div>
  );
}
