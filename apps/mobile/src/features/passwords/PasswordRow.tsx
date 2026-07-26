import type { PasswordSummary } from '@weavestream/shared';
import { Icon } from '../../components/Icon';

/**
 * One password card: title + username meta (two lines max, by
 * construction — the handoff's "never a third line"), with a trailing
 * copy button that reveals+copies WITHOUT navigating.
 *
 * Not built on `ListRow`: that primitive renders the whole row as one
 * `<button>` when tappable, and a copy `<button>` inside it would be
 * nested interactive content — invalid HTML with unreliable event
 * semantics. Here the card body is the open-button and the copy
 * control is an absolutely-positioned **sibling** overlaying its right
 * edge, so both stay real buttons.
 */
export function PasswordRow({
  password,
  onOpen,
  onCopy,
}: {
  password: PasswordSummary;
  onOpen: () => void;
  /** Absent for archived rows — reveal is blocked server-side anyway. */
  onCopy?: () => void;
}) {
  const archived = password.archivedAt !== null;

  return (
    <div className={'relative' + (archived ? ' opacity-55' : '')}>
      <button
        type="button"
        onClick={onOpen}
        className={
          'flex min-h-card w-full flex-col justify-center gap-1 rounded-card ' +
          'border border-line bg-surface py-3 pl-3.5 pr-[74px] text-left ' +
          'active:bg-panel-2'
        }
      >
        <span className="truncate text-card-title font-semibold text-text">
          {password.name}
        </span>
        <span className="truncate font-mono text-meta text-muted">
          {password.username?.trim() ? password.username : '—'}
        </span>
      </button>

      {archived ? (
        <span
          className={
            'absolute right-3.5 top-1/2 -translate-y-1/2 rounded-[7px] ' +
            'bg-panel px-2.25 py-1 font-mono text-[12px] uppercase ' +
            'tracking-[0.08em] text-muted'
          }
        >
          Archived
        </span>
      ) : (
        onCopy && (
          <button
            type="button"
            onClick={onCopy}
            // The label names the record: a screen reader tabbing a list
            // of identical "copy" buttons would be unusable.
            aria-label={`Copy password for ${password.name}`}
            className={
              'absolute right-3.5 top-1/2 h-[46px] w-[46px] -translate-y-1/2 ' +
              'rounded-field bg-accent-soft active:bg-accent-line ' +
              'flex items-center justify-center'
            }
          >
            <Icon name="content_copy" size={22} className="text-accent-deep" />
          </button>
        )
      )}
    </div>
  );
}
