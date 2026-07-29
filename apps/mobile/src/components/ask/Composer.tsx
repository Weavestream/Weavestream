import { useEffect, useRef } from 'react';
import { useOrgScope } from '../../lib/org-scope';
import { Icon } from '../Icon';
import { useAsk } from './AskProvider';

/**
 * The Ask composer — 54px resting height per the handoff, growing with
 * the draft. NO autofocus (the app-wide overlay rule; the search screen
 * is the one sanctioned exception, not this).
 *
 * While a send is active the send slot becomes **Stop** — for BOTH
 * `creating` and `streaming`: a stalled conversation-create POST must
 * be cancellable too, and flaky radios plus the server's 120s turn
 * timeout make a stuck disabled composer bad field UX. (Deliberate
 * deviation from desktop, which has no stop affordance.)
 */
export function Composer() {
  const { state, setDraft, send, stop } = useAsk();
  const { currentOrg } = useOrgScope();
  const global = currentOrg === null;
  const active = state.status !== 'idle';
  const canSend = !active && state.draft.trim().length > 0;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow with the draft, capped; reset when it clears.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, [state.draft]);

  return (
    <div className="flex items-end gap-2">
      <div
        className={
          'flex min-h-[54px] min-w-0 flex-1 items-center rounded-group ' +
          'border border-line bg-surface px-4 py-3.5'
        }
      >
        <textarea
          ref={textareaRef}
          rows={1}
          value={state.draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={active}
          placeholder={global ? 'Ask across your organizations…' : 'Ask about this org…'}
          aria-label={
            global ? 'Ask across your organizations' : 'Ask about this organization'
          }
          enterKeyHint="send"
          maxLength={8000}
          autoCapitalize="sentences"
          className={
            'max-h-32 min-w-0 flex-1 resize-none bg-transparent text-body ' +
            'leading-snug text-text outline-none placeholder:text-dim ' +
            'disabled:text-muted'
          }
        />
      </div>

      {active ? (
        <button
          type="button"
          onClick={stop}
          aria-label="Stop"
          className={
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-pill ' +
            'bg-text text-bg active:opacity-80'
          }
        >
          <Icon name="stop" size={22} />
        </button>
      ) : (
        <button
          type="button"
          onClick={send}
          disabled={!canSend}
          aria-label="Send"
          className={
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-pill ' +
            'bg-accent text-accent-ink active:bg-accent-pressed ' +
            'disabled:bg-line disabled:text-dim'
          }
        >
          <Icon name="arrow_upward" size={22} />
        </button>
      )}
    </div>
  );
}
