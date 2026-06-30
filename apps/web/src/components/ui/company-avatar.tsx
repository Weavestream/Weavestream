import { CompanyMark } from './company-mark';

type CompanyAvatarProps = {
  name: string;
  color?: string;
  size?: number;
  logoUrl?: string | null;
  square?: boolean;
  /**
   * Opt-in wider rendering for real logo placements. Compact slots
   * such as tables and pickers keep the default square avatar.
   */
  logoMaxWidth?: number;
  logoFrame?: boolean;
};

/**
 * Render a company's logo when one is set, falling back to the
 * initials-based `CompanyMark`. Signed thumbnail URLs expire after a
 * few minutes — callers are responsible for refetching data if they
 * need long-lived cached frames.
 */
export function CompanyAvatar({
  name,
  color,
  size = 24,
  logoUrl,
  square = true,
  logoMaxWidth,
  logoFrame = true,
}: CompanyAvatarProps) {
  if (logoUrl) {
    const wideLogo = logoMaxWidth !== undefined && logoMaxWidth > size;
    return (
      <img
        src={logoUrl}
        alt=""
        {...(wideLogo ? { height: size } : { width: size, height: size })}
        style={{
          width: wideLogo ? 'auto' : size,
          height: size,
          maxWidth: wideLogo ? logoMaxWidth : size,
          borderRadius: square ? 4 : '50%',
          objectFit: wideLogo ? 'contain' : 'cover',
          border: logoFrame ? '1px solid var(--line)' : 'none',
          background: logoFrame ? 'var(--panel-2)' : 'transparent',
          boxSizing: 'border-box',
          display: 'block',
          flexShrink: 0,
        }}
      />
    );
  }
  return <CompanyMark name={name} color={color} size={size} square={square} />;
}
