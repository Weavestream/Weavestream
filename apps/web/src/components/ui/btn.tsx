import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
} from 'react';
import type { IconComponent, IconProps } from './icon';

export type BtnKind = 'primary' | 'solid' | 'ghost' | 'outline' | 'danger';
export type BtnSize = 'sm' | 'md';

const sizeMap: Record<BtnSize, { h: number; px: number; fs: number }> = {
  sm: { h: 26, px: 9, fs: 12 },
  md: { h: 30, px: 11, fs: 12.5 },
};

// Every kind carries a visible 1px border in its own tone so a row of
// mixed-kind buttons (primary / outline / danger / ghost) lines up at
// the same outer dimensions — see the "all 4 same height + border"
// audit. `ghost` is the deliberate exception: it should still feel
// chrome-less for inline secondary actions.
export const btnKindMap: Record<
  BtnKind,
  { bg: string; fg: string; bd: string; hover: string }
> = {
  primary: {
    bg: 'var(--accent-fill)',
    fg: 'var(--accent-fill-ink)',
    bd: 'var(--accent-fill)',
    hover: 'var(--accent-fill-hover)',
  },
  solid: {
    bg: 'var(--panel-2)',
    fg: 'var(--text)',
    bd: 'var(--line-2)',
    hover: 'var(--elev)',
  },
  ghost: {
    bg: 'transparent',
    fg: 'var(--text-2)',
    bd: 'transparent',
    hover: 'var(--panel-2)',
  },
  outline: {
    bg: 'transparent',
    fg: 'var(--text-2)',
    bd: 'var(--line-2)',
    hover: 'var(--panel-2)',
  },
  danger: {
    bg: 'var(--danger-soft)',
    fg: 'var(--danger)',
    bd: 'var(--danger)',
    hover: 'color-mix(in oklch, var(--danger) 14%, transparent)',
  },
};

export type BtnProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children?: ReactNode;
  kind?: BtnKind;
  size?: BtnSize;
  icon?: IconComponent;
  iconAfter?: IconComponent;
  loading?: boolean;
  iconOnly?: boolean;
};

/**
 * Computed style object shared between `Btn` (button) and `LinkBtn`
 * (anchor). Kept exported so one-off header chips that need to be a
 * Next `Link` can render with the exact same dimensions/borders as a
 * sibling `Btn` without duplicating the token math.
 */
export function btnStyle({
  kind = 'ghost',
  size = 'sm',
  iconOnly,
  disabled,
}: {
  kind?: BtnKind;
  size?: BtnSize;
  iconOnly?: boolean;
  disabled?: boolean;
} = {}): CSSProperties {
  const s = sizeMap[size];
  const tone = btnKindMap[kind];
  return {
    height: s.h,
    padding: iconOnly ? 0 : `0 ${s.px}px`,
    width: iconOnly ? s.h : undefined,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    background: tone.bg,
    color: tone.fg,
    border: `1px solid ${tone.bd}`,
    borderRadius: 5,
    fontSize: s.fs,
    fontWeight: kind === 'primary' ? 600 : 500,
    letterSpacing: -0.1,
    whiteSpace: 'nowrap',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    textDecoration: 'none',
    transition: 'background-color 120ms ease, color 120ms ease',
  };
}

export function btnIconSize(size: BtnSize = 'sm'): IconProps['size'] {
  return size === 'sm' ? 12 : 13;
}

export function Btn({
  children,
  kind = 'ghost',
  size = 'sm',
  icon: I,
  iconAfter: IA,
  loading,
  iconOnly,
  disabled,
  style,
  ...rest
}: BtnProps) {
  const tone = btnKindMap[kind];
  const iconSize = btnIconSize(size);
  const css: CSSProperties = {
    ...btnStyle({ kind, size, iconOnly, disabled: disabled || loading }),
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    ...style,
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      style={css}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = tone.hover;
        rest.onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = tone.bg;
        rest.onMouseLeave?.(e);
      }}
    >
      {loading ? <Spinner size={iconSize} /> : I ? <I size={iconSize} /> : null}
      {children}
      {IA && !loading ? <IA size={iconSize} /> : null}
    </button>
  );
}

function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ animation: 'spin 700ms linear infinite' }}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.3"
        strokeWidth="1.5"
      />
      <path
        d="M8 2a6 6 0 0 1 6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
    </svg>
  );
}
