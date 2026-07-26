import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { Button } from '../../components/primitives';

/**
 * The `requireReasonToView` prompt, shared by the list's copy button
 * and the detail screen's reveal/copy actions.
 *
 * Opened **pre-emptively** when the flag is already known from the
 * summary/detail (saves an audited, throttled reveal round-trip that
 * would only come back 400), and **reactively** when a reveal fails
 * with `ReasonRequired` — the flag can change under a cached list.
 *
 * Local-state sheet (StepUpHost precedent), not a `?sheet=` search
 * param: it carries per-password context and must not outlive its
 * screen.
 *
 * The submit tap is the user gesture the clipboard write rides on when
 * `action === 'copy'` — `onSubmit` must start `copySecret`
 * synchronously, so this component hands the reason over in the click
 * handler with no awaits of its own.
 */
export function RevealReasonSheet({
  open,
  action,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** Which verb the primary button promises. */
  action: 'view' | 'copy';
  busy: boolean;
  error: string | null;
  onSubmit: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Fresh prompt per opening — a reason describes one access, and
  // pre-filling the last one would invite rubber-stamped audit rows.
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const valid = reason.trim().length > 0;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Reason required"
      initialFocusRef={inputRef}
      footer={
        <Button
          kind="primary"
          disabled={!valid || busy}
          onClick={() => onSubmit(reason.trim())}
        >
          {busy ? 'Working…' : action === 'copy' ? 'Copy password' : 'Reveal password'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-body text-text-2">
          This credential requires a reason to reveal. The reason is
          recorded in the audit log.
        </p>
        <textarea
          ref={inputRef}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="e.g. Customer ticket #1234"
          className={
            'w-full resize-none rounded-field border border-line bg-surface p-4 ' +
            'text-body text-text outline-none placeholder:text-dim ' +
            'focus:border-2 focus:border-accent'
          }
        />
        {error && (
          <p role="alert" className="text-meta font-mono text-danger">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
