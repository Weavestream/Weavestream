import { redirect } from 'next/navigation';
import type { DriverDescriptor, IntegrationDto } from '@weavestream/shared';
import { getMe, serverApiFetch } from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
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
 * Restricted to SUPER_ADMIN — this is a workspace-wide surface and
 * carries the fingerprint of every credential the workspace touches.
 */
export default async function IntegrationsPage() {
  const me = (await getMe())!;
  if (me.role !== 'SUPER_ADMIN') redirect('/admin');

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
        description="Connect external systems — Action1, RMM tools, identity providers — and fan their data into the right Weavestream companies. Removing an integration releases its assets without deleting them."
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
      </PageBody>
    </>
  );
}
