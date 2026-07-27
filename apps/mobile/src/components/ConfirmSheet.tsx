import type { ReactNode } from 'react';
import { Button } from './primitives';
import { Sheet } from './Sheet';

/**
 * A confirmation as a bottom sheet (Phase 4) — mobile's counterpart of
 * desktop's confirm `Dialog`, introduced for archive actions.
 *
 * Deliberately thin: local `open` state stays with the caller
 * (StepUpHost precedent), the body is plain children, and the footer is
 * always Cancel + one committing action. Archiving is reversible, but
 * it removes the record from every list a technician is standing in
 * front of — worth one deliberate tap. **Restore never confirms**: it
 * is the undo, and confirming the undo would punish recovery.
 */
export function ConfirmSheet({
  open,
  title,
  confirmLabel,
  tone = 'danger',
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  /** Visual weight of the committing button. Archive uses danger. */
  tone?: 'danger' | 'primary';
  /** Disables both buttons while the action is in flight. */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <div className="flex gap-2.5">
          <Button kind="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button kind={tone} onClick={onConfirm} disabled={busy}>
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className="pb-1 text-body text-text-2">{children}</div>
    </Sheet>
  );
}
