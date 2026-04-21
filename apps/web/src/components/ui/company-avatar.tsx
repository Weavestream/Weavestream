import { CompanyMark } from './company-mark';

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
}: {
  name: string;
  color?: string;
  size?: number;
  logoUrl?: string | null;
  square?: boolean;
}) {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: square ? 4 : '50%',
          objectFit: 'cover',
          border: '1px solid var(--line)',
          background: 'var(--panel-2)',
          flexShrink: 0,
        }}
      />
    );
  }
  return <CompanyMark name={name} color={color} size={size} square={square} />;
}
