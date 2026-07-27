import { useEffect, useRef } from 'react';
import { Icon } from '../Icon';
import { MarkdownBody } from '../richtext/MarkdownBody';
import type { AskMessage, AskState } from './ask-reducer';
import { proposalCards } from './proposal-card';

/**
 * The Ask transcript: the handoff's two bubble tones, assistant
 * markdown through the same renderer as articles (sanitization by
 * construction — react-markdown drops raw HTML; model output is
 * untrusted input like any other), read-only proposal cards, and the
 * transient tool-activity line.
 *
 * Auto-follow: the scroller sticks to the bottom while the user is
 * near it and stops the moment they scroll up to read — a delta must
 * never yank the view back down mid-read.
 */

const STICK_THRESHOLD_PX = 80;

export function Transcript({ state }: { state: AskState }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
  };

  useEffect(() => {
    const el = scrollerRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [state.messages, state.toolActivity]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col gap-3 overflow-y-auto px-4 py-2"
    >
      {state.messages.length === 0 && <Welcome />}

      {state.messages.map((message) =>
        message.role === 'user' ? (
          <UserBubble key={message.clientId} message={message} />
        ) : (
          <AssistantTurn key={message.clientId} message={message} />
        ),
      )}

      {state.toolActivity && (
        <p className="px-1 text-[13px] italic text-muted" role="status">
          {state.toolActivity}
        </p>
      )}
    </div>
  );
}

function Welcome() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Icon name="auto_awesome" size={28} className="text-accent" />
      {/* Desktop's ChatWelcome copy — the feature is "Ask anything". */}
      <p className="text-body text-muted">Ask anything to get started.</p>
    </div>
  );
}

function UserBubble({ message }: { message: AskMessage }) {
  return (
    <div
      className={
        'max-w-[78%] self-end whitespace-pre-wrap break-words rounded-[20px_20px_6px_20px] ' +
        'bg-text px-4 py-3 text-body leading-[1.45] text-bg'
      }
    >
      {message.text}
    </div>
  );
}

function AssistantTurn({ message }: { message: AskMessage }) {
  const cards = proposalCards(message.toolCalls);
  return (
    <div className="flex max-w-[90%] flex-col gap-2.5 self-start">
      <div
        className={
          'rounded-[20px_20px_20px_6px] border border-line bg-surface px-4 py-3.5'
        }
      >
        {message.text ? (
          <MarkdownBody source={message.text} />
        ) : message.state === 'streaming' ? (
          <p className="animate-pulse text-body text-muted">Thinking…</p>
        ) : message.state === 'stopped' ? (
          <p className="text-body italic text-muted">Stopped.</p>
        ) : null}

        {message.state === 'error' && (
          <p className="pt-1 text-[14px] text-danger" role="alert">
            {message.error ?? 'Something went wrong.'}
          </p>
        )}
      </div>

      {message.notices.map((notice, i) => (
        <p key={i} className="px-1 text-[13px] text-faint">
          {notice}
        </p>
      ))}

      {cards.map((card) => (
        <div
          key={card.id}
          className="flex flex-col gap-1 rounded-group border border-line bg-surface p-3.5"
        >
          <div className="flex items-center gap-2">
            <Icon name="description" size={20} className="text-accent" />
            <span className="text-body font-semibold text-text">
              {card.headline}
            </span>
          </div>
          {card.title && (
            <p className="truncate text-body text-text-2">{card.title}</p>
          )}
          {/* Read-only by decision — no Apply/Reject on mobile v1. */}
          <p className="text-[13px] text-muted">Review and apply on desktop.</p>
        </div>
      ))}
    </div>
  );
}
