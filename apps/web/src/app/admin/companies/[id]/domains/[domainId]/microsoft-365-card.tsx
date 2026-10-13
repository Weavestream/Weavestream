import type { MonitoredDomainDto } from '@weavestream/shared';
import { Panel } from '../../../../../../components/ui';
import { spacedRelativePast as fmtRelativePast } from '../../../../../../lib/relative-time';
import { microsoftDomainLabel } from '../workspace-role';
import { Stat } from './stat';

/** Microsoft's supportedServices names, in plain words; unknown ones show as sent. */
const SERVICE_NAMES: Readonly<Record<string, string>> = {
  Email: 'Email',
  OfficeCommunicationsOnline: 'Teams',
  Intune: 'Intune',
  Yammer: 'Viva Engage',
  SharePoint: 'SharePoint',
  OrgIdAuthentication: 'Sign-in',
};

/**
 * What Microsoft 365 says about this domain: shown on any row the Microsoft
 * domain sync created or matched. The Registrar panel stays Cloudflare's.
 * Only verified domains are synced, so a default flag means verified.
 */
export function Microsoft365Card({ domain }: { domain: MonitoredDomainDto }) {
  const role = microsoftDomainLabel(domain);
  const services = domain.microsoftServices.map((s) => SERVICE_NAMES[s] ?? s);
  return (
    <Panel
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- local public SVG icon; next/image SVG needs config */}
          <img src="/integrations/drivers/microsoft-365.svg" alt="" width={16} height={16} />
          Microsoft 365
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
        <Stat label="Domain" value={role ?? 'Not in Microsoft 365'} />
        <Stat label="Verified" value={role ? 'Yes' : 'No'} />
        <Stat
          label="Authentication"
          value={domain.microsoftAuthType === 'FEDERATED' ? 'Federated' : domain.microsoftAuthType === 'MANAGED' ? 'Managed' : 'Not reported'}
        />
        <Stat label="Services" value={services.length > 0 ? services.join(', ') : 'Not reported'} />
        <Stat
          label="Last synced"
          value={fmtRelativePast(domain.microsoftSyncedAt) ?? 'never'}
          sub={
            domain.microsoftMissingSince
              ? `Not in Microsoft 365 since ${domain.microsoftMissingSince.slice(0, 10)}`
              : undefined
          }
        />
        {domain.microsoftIntegrationName ? <Stat label="Integration" value={domain.microsoftIntegrationName} /> : null}
      </div>
    </Panel>
  );
}
