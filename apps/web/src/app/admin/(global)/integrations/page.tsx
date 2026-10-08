import { redirect } from 'next/navigation';
import type { DriverDescriptor, IntegrationDto } from '@weavestream/shared';
import { requireMe } from '../../../../lib/server-api/auth';
import { serverApiFetch } from '../../../../lib/server-api/core';
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
  const me = await requireMe();
  if (!hasCapability(me, 'INTEGRATION_MANAGE')) redirect('/admin');

  const [listRes, driversRes] = await Promise.all([
    serverApiFetch<IntegrationDto[]>('/admin/integrations'),
    serverApiFetch<{ drivers: DriverDescriptor[] }>(
      '/admin/integrations/drivers',
    ),
  ]);
  const integrations = listRes.data ?? [];
  const drivers = driversRes.data?.drivers ?? [];


  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Integrations' },
        ]}
        title="Integrations"
        description="Connect external systems and sync their data with companies in Weavestream. Removing an integration keeps its assets in Weavestream."
        actions={<CreateIntegrationButton drivers={drivers} />}
      />
      <PageBody>
        <Panel
          title={`${integrations.length} ${
            integrations.length === 1 ? 'integration' : 'integrations'
          }`}
          noPad
        >
          <IntegrationsTable rows={integrations} drivers={drivers} />
        </Panel>
        <AvailableIntegrationsGallery drivers={drivers} />
      </PageBody>
    </>
  );
}
