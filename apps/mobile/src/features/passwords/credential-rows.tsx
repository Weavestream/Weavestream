import type { ReactNode } from 'react';
import { safeExternalHref } from '@weavestream/shared';
import { Icon, type IconName } from '../../components/Icon';
import { Card } from '../../components/primitives';

/**
 * The 1c credential rows: label (mono-upper, muted) over value, with
 * 44×44 trailing actions. Copy on the password row is the PRIMARY
 * action (accent fill) — the handoff is explicit that copy outranks
 * reveal in the field.
 */

function FieldRow({
  label,
  children,
  trailing,
  gap = 'gap-1',
}: {
  label: string;
  children: ReactNode;
  trailing?: ReactNode;
  gap?: string;
}) {
  return (
    <Card className="flex items-center gap-2.5 px-4 py-[15px]">
      <div className={`flex min-w-0 flex-1 flex-col ${gap}`}>
        <span className="font-mono text-section uppercase tracking-[0.1em] text-muted">
          {label}
        </span>
        {children}
      </div>
      {trailing && <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </Card>
  );
}

function RowButton({
  icon,
  label,
  onClick,
  tone = 'neutral',
  disabled,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  /** `accent` = the row's primary action (the password copy button). */
  tone?: 'neutral' | 'accent';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      className={
        'flex h-tap w-11 items-center justify-center rounded-pill ' +
        (tone === 'accent'
          ? 'bg-accent-fill text-accent-fill-ink active:bg-accent-pressed'
          : 'bg-panel text-text-2 active:bg-panel-2') +
        (disabled ? ' opacity-50' : '')
      }
    >
      <Icon name={icon} size={21} />
    </button>
  );
}

export function UsernameRow({
  username,
  onCopy,
}: {
  username: string;
  onCopy: () => void;
}) {
  return (
    <FieldRow
      label="Username"
      trailing={<RowButton icon="content_copy" label="Copy username" onClick={onCopy} />}
    >
      <span className="break-all font-mono text-[17px] text-text">{username}</span>
    </FieldRow>
  );
}

export function PasswordValueRow({
  plaintext,
  remainingS,
  busy,
  onToggle,
  onCopy,
  onHideNow,
}: {
  plaintext: string | null;
  remainingS: number;
  busy: boolean;
  onToggle: () => void;
  onCopy: () => void;
  onHideNow: () => void;
}) {
  const revealed = plaintext !== null;
  return (
    <FieldRow
      label="Password"
      trailing={
        <>
          <RowButton
            icon={revealed ? 'visibility_off' : 'visibility'}
            label={revealed ? 'Hide password' : 'Reveal password'}
            onClick={onToggle}
            disabled={busy}
          />
          <RowButton
            icon="content_copy"
            label="Copy password"
            onClick={onCopy}
            tone="accent"
          />
        </>
      }
    >
      {revealed ? (
        <>
          {/* select-none matches desktop: the copy button is the exit
              for this value, not a text selection that lingers in the
              OS selection buffer. */}
          <span className="select-none break-all font-mono text-[17px] text-text">
            {plaintext}
          </span>
          <span className="flex items-center gap-2 font-mono text-[12px] text-muted">
            Hides in {remainingS}s ·
            <button type="button" onClick={onHideNow} className="underline">
              Hide now
            </button>
          </span>
        </>
      ) : (
        <span
          aria-label="Password hidden"
          className="font-mono text-[20px] leading-none tracking-[0.12em] text-text"
        >
          ••••••••
        </span>
      )}
    </FieldRow>
  );
}

/** Groups `418902` as `418 902`; odd digit counts split high (`1234567` → `1234 567`). */
function formatCode(code: string): string {
  if (code.length < 5) return code;
  const mid = Math.ceil(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

export function TotpRow({
  code,
  remainingS,
  progress,
  failed,
  onCopy,
}: {
  code: string | null;
  remainingS: number;
  progress: number;
  failed: boolean;
  onCopy: (code: string) => void;
}) {
  return (
    <FieldRow
      label="One-time code"
      gap="gap-1.5"
      trailing={
        <>
          {code && (
            <span
              aria-hidden
              className="flex h-tap w-11 items-center justify-center rounded-full"
              style={{
                background: `conic-gradient(var(--accent) ${progress * 360}deg, var(--line-3) 0)`,
              }}
            >
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-surface font-mono text-[13px] font-medium text-accent-deep">
                {remainingS}
              </span>
            </span>
          )}
          {code && (
            <RowButton
              icon="content_copy"
              label="Copy one-time code"
              onClick={() => onCopy(code)}
            />
          )}
        </>
      }
    >
      {code ? (
        <span className="font-mono text-[24px] leading-none tracking-[0.16em] text-text">
          {formatCode(code)}
        </span>
      ) : (
        <span className="font-mono text-meta text-muted">
          {failed ? 'Couldn’t load the code.' : '··· ···'}
        </span>
      )}
      <span className="sr-only" aria-live="off">
        One-time code valid for {remainingS} seconds
      </span>
    </FieldRow>
  );
}

export function UrlRow({ url, onCopy }: { url: string; onCopy: () => void }) {
  const href = safeExternalHref(url);
  return (
    <FieldRow
      label="URL"
      trailing={
        <>
          {href && (
            /* Anchor, not a button — long-press preview and "open in
               new tab" should behave like a link. Scheme-allowlisted
               via safeExternalHref; anything else renders copy-only. */
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open URL"
              className="flex h-tap w-11 items-center justify-center rounded-pill bg-panel text-text-2 active:bg-panel-2"
            >
              <Icon name="open_in_new" size={21} />
            </a>
          )}
          <RowButton icon="content_copy" label="Copy URL" onClick={onCopy} />
        </>
      }
    >
      <span className="break-all text-body text-text">{url}</span>
    </FieldRow>
  );
}

export function NotesCard({ text }: { text: string }) {
  return (
    <FieldRow label="Notes">
      {/* Plaintext only — never HTML, never a rich renderer (§3). */}
      <p className="whitespace-pre-wrap break-words text-body leading-relaxed text-text">
        {text}
      </p>
    </FieldRow>
  );
}
