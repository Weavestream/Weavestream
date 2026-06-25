import type { ReactNode } from 'react';
import { AdminShell } from '../../../components/shell/admin-shell';
import { getSettings, requireMe } from '../../../lib/server-api';
import { buildTerm } from '../../../lib/term';

/**
 * Layout for all non-company-scoped admin pages. Auth is handled by the
 * parent `/admin/layout.tsx`; here we just install the global `AdminShell`.
 *
 * Company-scoped routes live under `/admin/companies/[id]/**` (outside
 * this route group) and get their own `CompanyShell` via
 * `companies/[id]/layout.tsx`.
 */
export default async function AdminGlobalLayout({
  children,
}: {
  children: ReactNode;
}) {
  // Auth is enforced by the parent `/admin/layout.tsx`, but App Router
  // renders layouts and pages in parallel, so `requireMe()` guards here
  // too — a transient null `me` redirects to /login instead of crashing
  // a child that reads `me` before the parent's redirect lands.
  const me = await requireMe();
  const settings = await getSettings();
  const term = buildTerm(settings);

  return (
    <AdminShell
      me={me}
      workspace={{
        name: settings.workspaceName,
        subtitle: settings.workspaceSubtitle,
      }}
      term={term}
    >
      {children}
    </AdminShell>
  );
}
