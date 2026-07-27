import { UUID_RE } from './uuid';

/**
 * Recognize a desktop record URL inside stored/generated prose and name
 * the mobile screen that can render it.
 *
 * Why this exists: the Ask anything model cites records using the
 * `href` the AI search tool returns, and that helper
 * (`apps/api/src/search/entity-href.ts`) builds DESKTOP paths —
 * `/admin/companies/{cid}/{section}/{id}`. Article bodies can carry the
 * same shapes, hand-pasted. Rendering them raw sends a technician from
 * the mobile app into the desktop view mid-job.
 *
 * Deliberately narrow:
 *  - only the three sections mobile has detail screens for — anything
 *    else (domains, photos, the company overview, portal URLs, deeper
 *    paths like `/edit` or `/versions`) returns null and keeps its
 *    desktop link, which CAN render it;
 *  - exact five-segment shape, both ids UUID-checked — this is a
 *    display-affordance mapping, not an authorization decision (the
 *    server re-derives access on the detail fetch regardless);
 *  - query/fragment are dropped — the mobile detail screens take none.
 *
 * The caller must still compare `companyId` against the active org:
 * mobile detail screens fetch under the CURRENT org, so a cross-org
 * link would dead-end in a 404 — the desktop view is the honest target
 * for those.
 */

export interface DesktopRecordLink {
  companyId: string;
  /** Router path under the `/m` basepath, e.g. `/articles/<id>`. */
  to: string;
}

const MOBILE_SECTIONS: Record<string, string> = {
  articles: '/articles',
  assets: '/assets',
  passwords: '/passwords',
};

export function desktopRecordLink(href: string): DesktopRecordLink | null {
  if (!href.startsWith('/admin/companies/')) return null;
  const path = href.split(/[?#]/, 1)[0]!;
  const segments = path.split('/').filter(Boolean);
  // ['admin', 'companies', cid, section, id] — exactly; deeper paths
  // (edit, versions) have no mobile screen.
  if (segments.length !== 5) return null;
  const [, , companyId, section, id] = segments as [
    string,
    string,
    string,
    string,
    string,
  ];
  const base = MOBILE_SECTIONS[section];
  if (!base || !UUID_RE.test(companyId) || !UUID_RE.test(id)) return null;
  return { companyId, to: `${base}/${id}` };
}
