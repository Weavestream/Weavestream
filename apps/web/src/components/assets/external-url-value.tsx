import { safeExternalHref } from '@weavestream/shared';
import { Icon } from '../ui';

/**
 * Renders a user-stored URL field value (asset `URL` / `VAULTWARDEN_LINK`)
 * as an external link — or refuses to.
 *
 * The stored value is untrusted: current write paths validate the shape,
 * but legacy/pre-validation rows can hold anything, and a raw
 * `<a href={value}>` turns a scheme-less string into an in-app relative
 * route and honours whatever scheme is present (CLAUDE.md §3). The href
 * therefore always goes through `safeExternalHref`; a rejected value is
 * shown as plain text so the row still communicates what is stored,
 * and a blank value renders the usual `—` placeholder.
 */
export function ExternalUrlValue({
  url,
  label,
}: {
  url: string;
  /** Display text when it differs from the URL (Vaultwarden link labels). */
  label?: string;
}) {
  if (!url.trim()) return <span style={{ color: 'var(--dim)' }}>—</span>;

  const href = safeExternalHref(url);
  const text = label ?? url;

  if (!href) {
    return (
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 12.5,
          wordBreak: 'break-all',
        }}
      >
        {text}
      </span>
    );
  }

  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{
        color: 'var(--accent)',
        fontFamily: 'var(--font-mono)',
        fontSize: 12.5,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
    >
      {text}
      <Icon.ext size={11} />
    </a>
  );
}
