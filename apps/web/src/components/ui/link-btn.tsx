'use client';

import Link from 'next/link';
import type { AnchorHTMLAttributes, CSSProperties, ReactNode } from 'react';
import {
  btnKindMap,
  btnStyle,
  type BtnKind,
  type BtnSize,
} from './btn';

export type LinkBtnProps = Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'children'
> & {
  children?: ReactNode;
  kind?: BtnKind;
  size?: BtnSize;
  /**
   * Pre-rendered icon node (e.g. `<Icon.edit size={13} />`). We accept
   * a node rather than a component reference so server components can
   * pass it across the client boundary — function references aren't
   * serializable.
   */
  icon?: ReactNode;
  iconAfter?: ReactNode;
  iconOnly?: boolean;
  href: string;
};

/**
 * Anchor-shaped sibling of `Btn`. Renders a Next `Link` so client-side
 * navigation works out of the box. Visuals are identical to `Btn`
 * because both share `btnStyle()`.
 *
 * Marked `'use client'` because it registers hover handlers — server
 * components can import it freely and Next will boundary it correctly.
 */
export function LinkBtn({
  children,
  kind = 'ghost',
  size = 'sm',
  icon,
  iconAfter,
  iconOnly,
  style,
  ...rest
}: LinkBtnProps) {
  const tone = btnKindMap[kind];
  const css: CSSProperties = {
    ...btnStyle({ kind, size, iconOnly }),
    ...style,
  };
  return (
    <Link
      {...rest}
      style={css}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = tone.hover;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = tone.bg;
      }}
    >
      {icon}
      {children}
      {iconAfter}
    </Link>
  );
}
