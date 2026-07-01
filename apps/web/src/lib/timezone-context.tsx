'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import {
  formatCalendarDate,
  formatDate,
  formatDateTime,
  formatRelative,
  formatShortDateTime,
  type DateInput,
} from '@weavestream/shared';

/**
 * React context carrying the viewer's effective IANA timezone (their saved
 * `User.timezone`, or `'UTC'`). Seeded on the server by `<TimezoneProvider>`
 * in the shell layouts so client components format timestamps in the SAME zone
 * on the SSR and hydration renders. The shared formatters
 * (`@weavestream/shared`) are already deterministic across ICU versions; the
 * timezone is the one request-specific input they need.
 *
 * Kept in its own `'use client'` module (mirroring `term-context`) so server
 * components can import the pure `getEffectiveTimezone` helper from
 * `./date-format` without crossing the client boundary. Do NOT re-export that
 * server helper here — `'use client'` taints every export.
 *
 * The `'UTC'` default keeps any consumer rendered outside a provider
 * deterministic instead of throwing.
 */
const TimezoneContext = createContext<string>('UTC');

export function TimezoneProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: ReactNode;
}) {
  return (
    <TimezoneContext.Provider value={timezone}>
      {children}
    </TimezoneContext.Provider>
  );
}

/** The viewer's effective IANA timezone (`'UTC'` outside a provider). */
export function useTimezone(): string {
  return useContext(TimezoneContext);
}

/** Instant → `"Jul 1, 2026, 08:00 AM"` in the viewer's zone. */
export function FormattedDateTime({ value }: { value: DateInput }) {
  return <>{formatDateTime(value, useTimezone())}</>;
}

/** Instant → `"Jul 1, 08:00 AM"` (no year) in the viewer's zone. */
export function FormattedShortDateTime({ value }: { value: DateInput }) {
  return <>{formatShortDateTime(value, useTimezone())}</>;
}

/** Instant, date only → `"Jul 1, 2026"` in the viewer's zone. */
export function FormattedDate({ value }: { value: DateInput }) {
  return <>{formatDate(value, useTimezone())}</>;
}

/**
 * Calendar day → `"Jul 1, 2026"`, pinned UTC so it never shifts across zones.
 * Ignores the context zone by design — use for stored *days* (asset DATE
 * fields, expiry dates), not instants.
 */
export function FormattedCalendarDate({ value }: { value: DateInput }) {
  return <>{formatCalendarDate(value)}</>;
}

/**
 * Relative age (`"5m ago"`), hydration-safe.
 *
 * Renders an ABSOLUTE date on the first paint (server + hydration match), then
 * upgrades to a relative label in a post-mount effect. The upgrade is a normal
 * client state change, not a hydration mismatch. `useState(() => Date.now())`
 * would NOT be safe — the initializer runs on both renders with different
 * clocks. Pass a server-computed `nowMs` and call `formatRelative` directly
 * instead when the absolute→relative flash is undesirable.
 */
export function FormattedRelative({ value }: { value: DateInput }) {
  const tz = useTimezone();
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);
  return (
    <>
      {nowMs == null
        ? formatDateTime(value, tz)
        : formatRelative(value, nowMs, tz)}
    </>
  );
}
