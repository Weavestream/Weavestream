import { initialsFromName, roleLabel } from '@weavestream/shared';
import type { UserRole } from '@weavestream/shared';
import { Icon } from './Icon';
import { Avatar } from './primitives';

/**
 * "Who am I signed in as" — the identity block shown at the top of More
 * (tappable, the way into `/profile`) and again at the top of the profile
 * screen itself (inert, as context for what you are about to change).
 *
 * One component for both because the block is identical; the only
 * difference is whether it does anything. **It renders a `<button>` only
 * when `onClick` is supplied**, and a plain `<div>` otherwise — a
 * focusable, `active:`-styled element that does nothing is a worse lie
 * than no affordance at all, and the chevron follows the same condition
 * rather than being decoration.
 *
 * The email is here as *context*, deliberately with no copy about whether
 * it can be changed: it cannot (there is no self-service or admin path),
 * but a technician reading this needs to know which account they are
 * acting on, not to be handed a workflow.
 */
export function IdentityCard({
  name,
  email,
  userRole,
  onClick,
}: {
  /** Display name, or the email when the account has no name set. */
  name: string;
  email: string | undefined;
  /**
   * Named `userRole`, not `role`: a JSX prop called `role` is read as the
   * ARIA attribute (by `jsx-a11y`, and by anyone skimming the call site),
   * and `role="OPERATOR"` is not a valid ARIA role.
   */
  userRole: UserRole | undefined;
  /** Omit for the inert context rendering. */
  onClick?: () => void;
}) {
  const label = userRole ? roleLabel(userRole) : null;
  // MoreTab falls back to the email when there is no name, so printing the
  // email again on the meta line would show it twice. Role alone then.
  const showEmail = email !== undefined && email !== name;
  const meta = [label, showEmail ? email : null].filter(Boolean).join(' · ');

  const body = (
    <>
      <Avatar initials={initialsFromName(name)} size={46} shape="circle" tone="soft" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.75">
        <div className="truncate text-[18px] font-semibold tracking-[-0.015em] text-text">
          {name}
        </div>
        {meta && <div className="truncate font-mono text-meta text-muted">{meta}</div>}
      </div>
      {onClick && (
        <Icon name="chevron_right" size={22} className="shrink-0 text-faint" />
      )}
    </>
  );

  // Same geometry either way (46px circle, p-3.25, gap-3.25) so the card
  // does not shift between the two surfaces.
  const shell = 'flex w-full items-center gap-3.25 rounded-card border border-line bg-surface p-3.25';

  if (!onClick) return <div className={shell}>{body}</div>;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`${shell} text-left transition-colors active:bg-panel-2`}
    >
      {body}
    </button>
  );
}
