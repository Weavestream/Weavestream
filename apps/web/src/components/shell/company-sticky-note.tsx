import { Icon } from '../ui/icon';
import type { StickyNoteSeverity } from './sticky-note-context';

const TONES: Record<
  StickyNoteSeverity,
  { fg: string; bg: string; border: string }
> = {
  INFO: {
    fg: 'var(--info)',
    bg: 'var(--info-soft)',
    border: 'color-mix(in oklch, var(--info) 30%, transparent)',
  },
  WARN: {
    fg: 'var(--warn)',
    bg: 'var(--warn-soft)',
    border: 'color-mix(in oklch, var(--warn) 30%, transparent)',
  },
  CRITICAL: {
    fg: 'var(--danger)',
    bg: 'var(--danger-soft)',
    border: 'color-mix(in oklch, var(--danger) 40%, transparent)',
  },
};

/**
 * Per-company banner rendered as the top row of the breadcrumb header
 * (see `top-bar.tsx`), so the note and the crumb row stick to the
 * viewport as one block. Renders nothing when `text` is empty so the
 * caller can drop it in unconditionally.
 *
 * Body is plain text — React's text-node escaping is the only
 * sanitisation; no markdown, no HTML.
 */
export function CompanyStickyNote({
  text,
  severity,
}: {
  text: string | null;
  severity: StickyNoteSeverity | null;
}) {
  if (!text || !text.trim()) return null;
  const tone = TONES[severity ?? 'INFO'];
  return (
    <div
      role={severity === 'CRITICAL' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '8px 14px',
        background: tone.bg,
        borderBottom: `1px solid ${tone.border}`,
        fontSize: 13,
        lineHeight: 1.45,
        color: 'var(--text)',
      }}
    >
      <Icon.warn size={14} style={{ color: tone.fg, marginTop: 3, flexShrink: 0 }} />
      <div
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    </div>
  );
}
