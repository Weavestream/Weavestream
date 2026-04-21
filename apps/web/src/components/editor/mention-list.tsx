'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from 'react';
import type { MentionSuggestionItem } from './mention-extension';

export type MentionListHandle = {
  onKeyDown: (event: KeyboardEvent) => boolean;
};

export const MentionList = forwardRef<
  MentionListHandle,
  { items: MentionSuggestionItem[]; command: (item: MentionSuggestionItem) => void }
>(function MentionList({ items, command }, ref) {
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    setSelected(0);
  }, [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: (event) => {
      if (event.key === 'ArrowDown') {
        setSelected((s) => (items.length === 0 ? 0 : (s + 1) % items.length));
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((s) =>
          items.length === 0 ? 0 : (s - 1 + items.length) % items.length,
        );
        return true;
      }
      if (event.key === 'Enter') {
        const item = items[selected];
        if (item) {
          command(item);
          return true;
        }
      }
      return false;
    },
  }));

  return (
    <div className="sd-popover" role="listbox">
      <div className="sd-popover-head">Link to…</div>
      {items.length === 0 && (
        <div className="sd-popover-head" style={{ color: 'var(--muted)' }}>
          No matches yet — keep typing
        </div>
      )}
      {items.map((item, idx) => (
        <button
          key={`${item.kind}:${item.id}`}
          type="button"
          role="option"
          className="sd-popover-item"
          data-active={idx === selected}
          onMouseEnter={() => setSelected(idx)}
          onClick={() => command(item)}
        >
          <span className="sd-popover-item-icon">
            {item.kind === 'asset' ? '▥' : '¶'}
          </span>
          <span className="sd-popover-item-label">
            <span>{item.title}</span>
            <span
              style={{
                display: 'block',
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--dim)',
              }}
            >
              {item.companyName} · {item.kind}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
});
