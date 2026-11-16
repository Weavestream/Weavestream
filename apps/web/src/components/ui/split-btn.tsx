'use client';

import type { ReactNode } from 'react';
import { Btn, btnIconSize, btnStyle, type BtnKind, type BtnSize } from './btn';
import type { IconComponent } from './icon';
import { Icon } from './icon';
import { OverflowMenu } from './overflow-menu';

/**
 * A primary action with its secondary variants behind an attached
 * chevron — "Publish ▾ / Save draft". The main half is a plain `Btn`;
 * the chevron half is an `OverflowMenu` re-skinned to match it, so the
 * popover, keyboard model, and dismissal rules are the shared ones.
 * Fill the menu with `MenuItem` rows via the `menu` render prop.
 *
 * Use it when the secondary action should not compete with the primary
 * one for a slot in the header: it stays one click away instead of one
 * glance.
 */
export function SplitBtn({
  children,
  kind = 'primary',
  size = 'md',
  icon,
  loading,
  disabled,
  onClick,
  menuLabel,
  menu,
}: {
  children: ReactNode;
  kind?: BtnKind;
  size?: BtnSize;
  icon?: IconComponent;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** Accessible name + tooltip for the chevron trigger. */
  menuLabel: string;
  /** Render prop, as for `OverflowMenu`: call `close` after acting. */
  menu: (close: () => void) => ReactNode;
}) {
  const off = disabled || loading;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'stretch' }}>
      <Btn
        kind={kind}
        size={size}
        icon={icon}
        loading={loading}
        disabled={disabled}
        onClick={onClick}
        style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
      >
        {children}
      </Btn>
      <OverflowMenu
        label={menuLabel}
        disabled={off}
        triggerIcon={<Icon.chevronD size={btnIconSize(size)} stroke={1.8} />}
        triggerStyle={{
          ...btnStyle({ kind, size, iconOnly: true, disabled: off }),
          // Overlap the shared 1px border so the halves read as one control.
          marginLeft: -1,
          borderTopLeftRadius: 0,
          borderBottomLeftRadius: 0,
        }}
      >
        {menu}
      </OverflowMenu>
    </span>
  );
}
