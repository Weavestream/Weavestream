import { effectiveCompanyAccess, type CompanyAccess } from '@weavestream/shared';
import { useMe } from '../screens/TabShell';
import { useOrgScope } from './org-scope';

/**
 * The current viewer's effective access to the current org, for hiding
 * unreachable controls — and nothing more. The server re-derives
 * authorization from the session on every request and will 403 anything
 * stale (CLAUDE.md §1); rendering a control this hook would hide changes
 * what's tappable, never what's permitted.
 *
 * `isClientUser` is separate from `canWrite` deliberately: a CLIENT_USER
 * can hold a FULL membership, but the password screens must still not
 * offer them write UI — a mobile create never sends `visibleToClients`,
 * the server defaults it to `false`, and client reads require `true`, so
 * they would create a record they can never see again. Desktop reaches
 * the same end by routing client users to the read-only portal.
 */
export interface CompanyAccessInfo {
  access: CompanyAccess;
  /** FULL access on the current org. Gate on this AND role — see above. */
  canWrite: boolean;
  isClientUser: boolean;
}

export function useCompanyAccess(): CompanyAccessInfo {
  const me = useMe();
  const { currentOrg } = useOrgScope();
  const access: CompanyAccess = currentOrg
    ? effectiveCompanyAccess(me, currentOrg.id)
    : 'NONE';
  return {
    access,
    canWrite: access === 'FULL',
    isClientUser: me?.role === 'CLIENT_USER',
  };
}
