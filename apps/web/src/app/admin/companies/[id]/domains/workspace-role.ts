import type { MonitoredDomainDto } from '@weavestream/shared';

// Plain module (no 'use client'): the server-rendered domain page calls this too.
/** "Primary domain" / "Secondary domain" / "Domain alias of x" for a Workspace role. */
export function workspaceRoleLabel(
  row: Pick<MonitoredDomainDto, 'workspaceRole' | 'workspaceAliasOf'>,
): string | null {
  switch (row.workspaceRole) {
    case 'PRIMARY':
      return 'Primary domain';
    case 'SECONDARY':
      return 'Secondary domain';
    case 'ALIAS':
      return row.workspaceAliasOf ? `Domain alias of ${row.workspaceAliasOf}` : 'Domain alias';
    default:
      return null;
  }
}

/** "Default domain" / "Verified domain" for a Microsoft 365 domain, null when not in the tenant. */
export function microsoftDomainLabel(row: Pick<MonitoredDomainDto, 'microsoftDefault'>): string | null {
  if (row.microsoftDefault === null) return null;
  return row.microsoftDefault ? 'Default domain' : 'Verified domain';
}
