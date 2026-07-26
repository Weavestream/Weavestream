import type {
  ButtonHTMLAttributes,
  ComponentPropsWithRef,
  ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Mobile's own primitives, built against the design handoff's spec
 * tables (`Build_Plan/Mobile/design_handoff_weavestream_mobile/README.md`).
 *
 * Two standing rules, both from CLAUDE.md:
 *
 *  - **Nothing here may come from `apps/web`.** Desktop's radii are
 *    3–8px against mobile's 9–30px, and its icons are drawn for a 16px
 *    viewBox. Sharing would drag both toward a compromise neither wants.
 *  - **No literal hexes.** Every colour is a token, so the user's accent
 *    preference carries over from desktop and a palette change lands
 *    here for free. Where the handoff's hex differs slightly from the
 *    token, the token wins.
 *
 * Tailwind classes rather than inline `CSSProperties` — that inversion
 * from desktop's idiom is deliberate and was already set by Phase 0.
 */

// ───────────────────────────────────────────────────────────────────
// Type + layout
// ───────────────────────────────────────────────────────────────────

/** Screen title — handoff: Geist 600, 28–30px, −0.025em. */
export function Title({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1 className={`text-screen-title font-semibold text-text ${className}`}>
      {children}
    </h1>
  );
}

export function Subtitle({ children }: { children: ReactNode }) {
  return <p className="text-body text-muted">{children}</p>;
}

/** Mono, 12px, 0.1em, uppercase — the handoff's section label. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="font-mono text-section font-medium uppercase text-muted">
      {children}
    </div>
  );
}

/**
 * A plain content screen: safe-area padding, 16px gutters, scrolls.
 *
 * `100dvh`-based rather than `100vh` — on iOS Safari `vh` includes the
 * area behind the toolbar, which pushes anything bottom-anchored
 * off-screen. `min-h-0` is what actually lets the overflow clip inside
 * the flex column instead of the child sizing to its content.
 */
export function Screen({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <main
      className={
        // `max-w-page` = the one shared content column (tokens.css),
        // identical on headers and bodies so nothing misaligns at any
        // window width.
        'mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col gap-4 ' +
        // NOT `pb-safe-b`: the tab bar below already carries the
        // bottom inset. This is plain clearance so the last card
        // doesn't butt against the tab bar's top border. No top inset
        // either — the header above owns `pt-edge-t`, and stacking a
        // second safe-area pad here would double it on notched phones.
        `overflow-y-auto px-4 pb-5 ${className}`
      }
    >
      {children}
    </main>
  );
}

// ───────────────────────────────────────────────────────────────────
// Controls
// ───────────────────────────────────────────────────────────────────

type ButtonKind = 'primary' | 'secondary' | 'danger';

const BUTTON_TONE: Record<ButtonKind, string> = {
  // `active:` rather than `hover:` — this is a touch-only app, and the
  // handoff's press feedback is a ~4% darken (or the platform highlight).
  primary:
    'bg-accent text-accent-ink active:bg-accent-pressed ' +
    'disabled:bg-line disabled:text-dim',
  secondary:
    'border border-line bg-surface text-text active:bg-panel-2 ' +
    'disabled:text-dim',
  danger:
    'border border-line bg-surface text-danger active:bg-panel-2 ' +
    'disabled:text-dim',
};

export function Button({
  children,
  kind = 'primary',
  icon,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: ButtonKind;
  icon?: IconName;
}) {
  return (
    <button
      {...rest}
      className={
        'flex h-control w-full items-center justify-center gap-2 ' +
        'rounded-pill text-body font-semibold transition-colors ' +
        `${BUTTON_TONE[kind]} ${className}`
      }
    >
      {icon && <Icon name={icon} size={20} />}
      {children}
    </button>
  );
}

/**
 * Icon-only control. 40×40 visually (the handoff's header buttons) but
 * the tap target is the 44px floor from `globals.css`, so the two
 * numbers deliberately disagree.
 *
 * `label` is required, not optional: an icon-only button with no
 * accessible name is invisible to a screen reader, and the copy button
 * on a password row is exactly the case where that matters.
 */
export function IconButton({
  icon,
  label,
  size = 22,
  className = '',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  icon: IconName;
  label: string;
  size?: number;
}) {
  return (
    <button
      {...rest}
      aria-label={label}
      className={
        'flex h-10 w-10 items-center justify-center rounded-btn ' +
        `border border-line bg-surface text-text-2 active:bg-panel-2 ${className}`
      }
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={htmlFor} className="text-body font-medium text-text">
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * `h-field` is 50px per the handoff's input spec. The 16px floor on
 * font-size lives in `globals.css` — below it iOS zooms the viewport on
 * focus, which on a login form reads as the page breaking.
 */
export function Input({
  mono,
  className = '',
  ...rest
}: ComponentPropsWithRef<'input'> & { mono?: boolean }) {
  return (
    <input
      {...rest}
      className={
        'h-[50px] w-full rounded-field border border-line bg-surface px-4 ' +
        'text-body text-text outline-none placeholder:text-dim ' +
        'focus:border-2 focus:border-accent ' +
        (mono ? 'text-center font-mono tracking-[0.2em] ' : '') +
        className
      }
    />
  );
}

/** Filter chip — handoff: 38px, radius 11px, active is ink-on-frame. */
export function Chip({
  children,
  icon,
  active = false,
  iconClassName = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  active?: boolean;
  iconClassName?: string;
}) {
  return (
    <button
      {...rest}
      aria-pressed={active}
      className={
        'flex h-chip shrink-0 items-center gap-1.5 rounded-chip px-3.5 ' +
        'text-body font-medium transition-colors ' +
        (active
          ? 'bg-text text-bg'
          : 'border border-line bg-surface text-text-2 active:bg-panel-2')
      }
    >
      {/* `iconClassName` exists for the handoff's at-risk chip, whose
          icon is `--danger` while its label stays `--text-2`. */}
      {icon && (
        <Icon name={icon} size={18} className={iconClassName || 'text-muted'} />
      )}
      {children}
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────
// Surfaces
// ───────────────────────────────────────────────────────────────────

/** Card surface — handoff: white, 1px border, radius 16px. */
export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-card border border-line bg-surface ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Tappable list row: leading slot, two lines of text, trailing slot.
 *
 * **Two lines is the maximum** — title plus one meta line, never a
 * third. That is the handoff's hard constraint, and it is what keeps a
 * usable number of rows above the fold.
 */
export function ListRow({
  title,
  meta,
  leading,
  trailing,
  selected = false,
  minHeight = 'card',
  metaFont = 'mono',
  onClick,
}: {
  title: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  /** `card` = 74px (password rows), `row` = 70px (org/search rows). */
  minHeight?: 'card' | 'row';
  /**
   * The handoff splits these: usernames, IPs and codes are Geist Mono,
   * prose meta (an org's location, "Current organization") is Geist.
   * Mono is the default because the credential rows are the common case.
   */
  metaFont?: 'mono' | 'sans';
  onClick?: () => void;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button' as const, onClick } : {})}
      className={
        'flex w-full items-center gap-3.5 rounded-card border p-3.5 text-left ' +
        (minHeight === 'card' ? 'min-h-card-min ' : 'min-h-row-min ') +
        (selected
          ? 'border-accent-line bg-accent-soft '
          : 'border-line bg-surface ') +
        (onClick ? 'active:bg-panel-2 transition-colors' : '')
      }
    >
      {leading}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="truncate text-card-title font-semibold text-text">
          {title}
        </div>
        {meta && (
          <div
            className={
              'truncate text-meta text-muted ' +
              (metaFont === 'mono' ? 'font-mono' : '')
            }
          >
            {meta}
          </div>
        )}
      </div>
      {trailing}
    </Tag>
  );
}

/** Grouped container — rows hairlined together inside one radius-18 box. */
export function GroupedList({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-group border border-line bg-surface">
      {children}
    </div>
  );
}

/** A 54px row inside a `GroupedList`. */
export function GroupedRow({
  icon,
  label,
  onClick,
  last = false,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  last?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex h-group-row w-full items-center gap-3.5 px-4 text-left ' +
        'transition-colors active:bg-panel-2 ' +
        (last ? '' : 'border-b border-line')
      }
    >
      <Icon name={icon} size={22} className="text-text-2" />
      <span className="flex-1 text-card-title font-medium text-text">
        {label}
      </span>
      <Icon name="chevron_right" size={22} className="text-faint" />
    </button>
  );
}

/**
 * Initials avatar. `shape` covers the handoff's three sizes: the 28px
 * header org tile (radius 9), the 44px sheet row tile (radius 13), and
 * the 46px circular profile avatar.
 */
export function Avatar({
  initials,
  size = 44,
  shape = 'tile',
  tone = 'neutral',
}: {
  initials: string;
  size?: number;
  shape?: 'tile' | 'circle';
  tone?: 'neutral' | 'accent' | 'soft';
}) {
  const tones = {
    neutral: 'bg-panel-2 text-text-2',
    accent: 'bg-accent text-accent-ink',
    soft: 'bg-accent-soft text-accent-deep',
  } as const;
  return (
    <span
      aria-hidden
      className={
        'flex shrink-0 items-center justify-center font-semibold ' +
        (shape === 'circle'
          ? 'rounded-full '
          : // The handoff gives the small header tile a tighter radius
            // (9px) than the 44px sheet tile (13px).
            size <= 32
            ? 'rounded-tile '
            : 'rounded-pill ') +
        tones[tone]
      }
      style={{
        width: size,
        height: size,
        // Scaled rather than tokenised: the same component serves a 28px
        // header tile and a 46px profile avatar, and the handoff gives
        // each its own type size (11px / 15px / 16px).
        fontSize: Math.round(size * 0.34),
      }}
    >
      {initials}
    </span>
  );
}
