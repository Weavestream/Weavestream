'use client';

import type { CSSProperties } from 'react';
import { Icon } from '../ui';
import {
  useChatPanel,
  type ChatTab,
} from './chat-panel-provider';

/**
 * Above-the-composer strip showing the current "page" context the LLM
 * will see on the next turn. Locked — can only be cleared by navigating
 * away from the page that registered it. Explicit @-mentions are NOT
 * shown here; they live inline in the message text as `@[Title]`
 * reference tokens (rendered with the accent color in user bubbles).
 *
 * Hidden entirely when there's no page context.
 */
// `tab` is unused for now but kept in the signature so the strip can be
// extended later (per-tab pills, locked overrides, etc.) without
// changing every call site.
export function ChatContextStrip(_props: { tab: ChatTab }) {
  const { state } = useChatPanel();
  const pageContext = state.pageContext;
  if (!pageContext) return null;
  const isAsset = pageContext.kind === 'asset';
  const icon = isAsset ? <Icon.box size={11} /> : <Icon.doc size={11} />;
  const label =
    pageContext.title || (isAsset ? 'Current asset' : 'Current page');
  const subtitle = isAsset ? pageContext.layoutName : null;
  const tooltip = isAsset
    ? `Auto-attached because you're viewing this asset (${pageContext.layoutName})`
    : "Auto-attached because you're viewing this page";
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
        padding: '8px 10px',
        borderTop: '1px solid var(--line)',
        background: 'var(--panel-2)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--dim)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
          marginRight: 2,
        }}
      >
        Context
      </span>
      <Pill icon={icon} label={label} subtitle={subtitle} locked title={tooltip} />
    </div>
  );
}

function Pill({
  icon,
  label,
  subtitle,
  onRemove,
  locked,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  subtitle?: string | null;
  onRemove?: () => void;
  locked?: boolean;
  title?: string;
}) {
  const wrap: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 22,
    padding: locked ? '0 8px' : '0 4px 0 8px',
    borderRadius: 11,
    border: '1px solid var(--line)',
    background: 'var(--panel)',
    color: 'var(--text)',
    fontSize: 11.5,
    maxWidth: 200,
  };
  return (
    <span style={wrap} title={title}>
      <span style={{ color: 'var(--dim)', flexShrink: 0, display: 'inline-flex' }}>
        {icon}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {subtitle ? (
        <span
          style={{
            color: 'var(--dim)',
            fontSize: 10.5,
            flexShrink: 0,
            maxWidth: 80,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subtitle}
        </span>
      ) : null}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${label}`}
          style={{
            width: 16,
            height: 16,
            display: 'grid',
            placeItems: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--dim)',
            borderRadius: 4,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <Icon.x size={9} />
        </button>
      )}
    </span>
  );
}
