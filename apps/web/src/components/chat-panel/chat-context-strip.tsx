'use client';

import type { CSSProperties } from 'react';
import { Icon } from '../ui';
import {
  useChatPanel,
  type ChatTab,
} from './chat-panel-provider';

/**
 * Above-the-composer strip showing what context the LLM will see on
 * the next turn. Two kinds of pills:
 *  - "Page" pill: auto-attached, sourced from the provider-wide page
 *    context (set by `useChatPageContext`). Locked — can only be
 *    cleared by navigating away from the page that registered it.
 *  - "@-mention" pills: explicit user picks on this tab, removable
 *    via the × on each pill.
 *
 * Hidden entirely when there's neither a page context nor any
 * mentions, so freeform conversations stay visually clean.
 */
export function ChatContextStrip({ tab }: { tab: ChatTab }) {
  const { state, removeMention } = useChatPanel();
  const pageContext = state.pageContext;
  const hasPage = !!pageContext;
  const hasMentions = tab.mentions.length > 0;
  if (!hasPage && !hasMentions) return null;
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
      {pageContext && (
        <Pill
          icon={<Icon.doc size={11} />}
          label={pageContext.title || 'Current page'}
          locked
          title="Auto-attached because you're viewing this page"
        />
      )}
      {tab.mentions.map((m) => (
        <Pill
          key={m.id}
          icon={<Icon.doc size={11} />}
          label={m.title}
          onRemove={() => removeMention(tab.id, m.id)}
          title="Click × to remove"
        />
      ))}
    </div>
  );
}

function Pill({
  icon,
  label,
  onRemove,
  locked,
  title,
}: {
  icon: React.ReactNode;
  label: string;
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
