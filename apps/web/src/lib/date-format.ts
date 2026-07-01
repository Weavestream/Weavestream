import type { Me } from './server-api';
import { normalizeTimeZone } from '@weavestream/shared';

/**
 * The timezone a signed-in user's timestamps should render in: their saved
 * `User.timezone`, or UTC when unset (or malformed — `normalizeTimeZone`
 * guards). Computed on the server in the shell layouts and handed to
 * `<TimezoneProvider>`, so client components format in the SAME zone on the
 * SSR render and the hydration render — the shared formatters are otherwise
 * deterministic, and the zone is the one request-specific input.
 *
 * Server-safe on purpose: this lives outside the `'use client'`
 * `timezone-context` module so server components can call it without dragging
 * the client boundary across (mirrors `term` vs `term-context`).
 */
export function getEffectiveTimezone(me: Pick<Me, 'timezone'>): string {
  return normalizeTimeZone(me.timezone);
}
