import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';
import type { IconComponent, IconProps } from './icon';

type BtnKind = 'primary' | 'solid' | 'ghost' | 'outline' | 'danger';
type BtnSize = 'sm' | 'md';

const sizeMap: Record<BtnSize, { h: number; px: number; fs: number }> = {
  sm: { h: 26, px: 9, fs: 12 },
  md: { h: 30, px: 11, fs: 12.5 },
};

const kindMap: Record<BtnKind, { bg: string; fg: string; bd: string; hover: string }> = {
  primary: {
    bg: 'var(--accent)',
    fg: 'var(--accent-ink)',
    bd: 'transparent',
    hover: 'color-mix(in oklch, var(--accent) 90%, black)',
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
    bd: 'transparent',
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
  const s = sizeMap[size];
  const tone = kindMap[kind];
  const iconSize: IconProps['size'] = size === 'sm' ? 12 : 13;
  const css: CSSProperties = {
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
    cursor: disabled || loading ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'background-color 120ms ease, color 120ms ease',
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
