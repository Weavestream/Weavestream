import Link from 'next/link';

/**
 * "Show dismissed" / "Hide dismissed" link for the Expiring-soon panels.
 * The state lives in the `?dismissed=1` query param so the server page
 * fetches dismissed rows only when asked.
 */
export function DismissedToggle({ href, showing }: { href: string; showing: boolean }) {
  return (
    <Link
      href={showing ? href : `${href}?dismissed=1`}
      style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 400 }}
    >
      {showing ? 'Hide dismissed' : 'Show dismissed'}
    </Link>
  );
}
