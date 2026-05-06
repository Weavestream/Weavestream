import { redirect } from 'next/navigation';
import type { DriverDescriptor, IntegrationDto } from '@weavestream/shared';
import { getMe, serverApiFetch } from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { AvailableIntegrationsGallery } from './available-integrations-gallery';
import { IntegrationsTable } from './integrations-table';
import { CreateIntegrationButton } from './create-integration-button';

/**
 * Phase 11 — global integrations admin landing.
 *
 * Lists every configured integration (one row per `Integration`,
 * regardless of how many companies it fans out to). Operators land
 * here to create, pause, or remove a global integration; per-company
 * mapping editing happens on the integration detail page.
 *
 * Gated on `INTEGRATION_MANAGE` — SUPER_ADMIN holds it implicitly,
 * OPERATORs can be granted the capability for delegated platform admin.
 */
export default async function IntegrationsPage() {
  const me = (await getMe())!;
  if (!hasCapability(me, 'INTEGRATION_MANAGE')) redirect('/admin');

  const [listRes, driversRes] = await Promise.all([
    serverApiFetch<IntegrationDto[]>('/admin/integrations'),
    serverApiFetch<{ drivers: DriverDescriptor[] }>(
      '/admin/integrations/drivers',
    ),
  ]);
  const integrations = listRes.data ?? [];
  const drivers = driversRes.data?.drivers ?? [];

  const driverKindByKey = new Map(
    drivers.map((d) => [d.key, d.capabilities.kind]),
  );
  const assetSyncRows = integrations.filter(
    (r) => (driverKindByKey.get(r.driver) ?? 'pull') === 'pull',
  );
  const securityRows = integrations.filter(
    (r) => driverKindByKey.get(r.driver) === 'security',
  );

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Integrations' },
        ]}
        title="Integrations"
        description="Connect external systems — Action1, RMM tools, identity providers — and fan their data into the right Weavestream companies. Removing an integration releases its assets without deleting them."
        actions={<CreateIntegrationButton drivers={drivers} />}
      />
      <PageBody>
        <Panel
          title={`Asset sync · ${assetSyncRows.length} ${
            assetSyncRows.length === 1 ? 'integration' : 'integrations'
          }`}
          noPad
        >
          <IntegrationsTable rows={assetSyncRows} drivers={drivers} />
        </Panel>
        <Panel
          title={`Security · ${securityRows.length} ${
            securityRows.length === 1 ? 'integration' : 'integrations'
          }`}
          noPad
        >
          <IntegrationsTable rows={securityRows} drivers={drivers} />
        </Panel>
        <AvailableIntegrationsGallery drivers={drivers} />
      </PageBody>
    </>
  );
}
