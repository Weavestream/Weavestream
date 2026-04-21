/**
 * Tenant terminology. UI labels only — URL paths, API routes, and
 * database columns continue to say "company" under the hood. Every
 * user-facing "Company" / "Companies" string in the app should go
 * through these helpers.
 *
 *   term.one         -> "Company"      (singular)
 *   term.other       -> "Companies"    (plural)
 *   term.possessive  -> "Company's"    (singular possessive)
 *
 * This module holds server-safe pure utilities only. The React context
 * + `useTerm()` hook live in `./term-context` (a `'use client'`
 * module) so server components can import `buildTerm` / `lower` /
 * `capitalize` / `TERM_PRESETS` without triggering Turbopack's
 * client-boundary guard.
 */

export interface Term {
  one: string;
  other: string;
  possessive: string;
}

/**
 * Shipped preset list — curated to cover the common MSP / IT /
 * homelab framings the app will plausibly be installed for. "custom"
 * is a sentinel the settings form uses to allow fully free-form
 * values without matching one of these.
 */
export const TERM_PRESETS = [
  { id: 'company', one: 'Company', other: 'Companies', possessive: "Company's" },
  { id: 'client', one: 'Client', other: 'Clients', possessive: "Client's" },
  { id: 'customer', one: 'Customer', other: 'Customers', possessive: "Customer's" },
  {
    id: 'department',
    one: 'Department',
    other: 'Departments',
    possessive: "Department's",
  },
  { id: 'tenant', one: 'Tenant', other: 'Tenants', possessive: "Tenant's" },
  {
    id: 'organization',
    one: 'Organization',
    other: 'Organizations',
    possessive: "Organization's",
  },
  { id: 'site', one: 'Site', other: 'Sites', possessive: "Site's" },
] as const;

export type TermPresetId = (typeof TERM_PRESETS)[number]['id'] | 'custom';

export const DEFAULT_TERM: Term = {
  one: 'Company',
  other: 'Companies',
  possessive: "Company's",
};

/**
 * Build a Term from the raw settings row. Possessive is optional in
 * the DB; when absent we derive `${singular}'s`, which is correct for
 * every English noun this UI is likely to see. The admin form exposes
 * the field for terms where that's wrong.
 */
export function buildTerm(raw: {
  tenantTermSingular: string;
  tenantTermPlural: string;
  tenantTermPossessive: string | null;
}): Term {
  const one = raw.tenantTermSingular;
  const other = raw.tenantTermPlural;
  const possessive = raw.tenantTermPossessive ?? `${one}'s`;
  return { one, other, possessive };
}

/**
 * Utility for start-of-sentence usage. Admins configuring "location"
 * still get "Location overview" in a heading.
 */
export function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Lowercase helper for mid-sentence usage ("Select a company to
 * continue"). Mirrors `capitalize`.
 */
export function lower(s: string): string {
  if (!s) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
