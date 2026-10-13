import type { MonitoredDomainDto } from '@weavestream/shared';
import { Panel } from '../../../../../../components/ui';
import { spacedRelativePast as fmtRelativePast } from '../../../../../../lib/relative-time';
import { workspaceRoleLabel } from '../workspace-role';
import { Stat } from './stat';

/**
 * What Google Workspace says about this domain: shown on any row the
 * Workspace domain sync created or matched. The Registrar panel stays
 * Cloudflare's. Only verified domains are synced, so a role means verified.
 */
export function GoogleWorkspaceCard({ domain }: { domain: MonitoredDomainDto }) {
  const role = workspaceRoleLabel(domain);
  return (
    <Panel
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local public SVG icon; next/image SVG needs config */}
          <img src="/integrations/drivers/google-workspace.svg" alt="" width={16} height={16} />
          Google Workspace
        </span>
      }
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 16,
        }}
      >
        <Stat label="Role" value={role ?? 'Not in Workspace'} />
        <Stat label="Verified" value={role ? 'Yes' : 'No'} />
        <Stat
          label="Last synced"
          value={fmtRelativePast(domain.workspaceSyncedAt) ?? 'never'}
          sub={
            domain.workspaceMissingSince
              ? `Not in Google Workspace since ${domain.workspaceMissingSince.slice(0, 10)}`
              : undefined
          }
        />
        {domain.workspaceIntegrationName ? (
          <Stat label="Integration" value={domain.workspaceIntegrationName} />
        ) : null}
      </div>
    </Panel>
  );
}
