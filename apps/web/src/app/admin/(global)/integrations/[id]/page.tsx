import { redirect } from 'next/navigation';
import type {
  DriverDescriptor,
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationSyncRunDto,
} from '@weavestream/shared';
import {
  getMe,
  serverApiFetch,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { hasCapability } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel } from '../../../../../components/ui';
import { IntegrationTabs } from './integration-tabs';

/**
 * Phase 11 — integration detail.
 *
 * Four tabs (rendered client-side via local URL hash):
 *   1. Credentials & schedule (status, name, secret rotation, cron).
 *   2. Field mappings (GLOBAL: layout + match keys + projections).
 *   3. Organizations (per-company mappings — enable/disable, delete).
 *   4. Runs (sync run history with totals + conflicts).
 *
 * Gated on `INTEGRATION_MANAGE`; SUPER_ADMIN holds it implicitly.
 */
export default async function IntegrationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const me = (await getMe())!;
  if (!hasCapability(me, 'INTEGRATION_MANAGE')) redirect('/admin');

  const [intRes, mappingsRes, runsRes, driversRes] = await Promise.all([
    serverApiFetch<IntegrationDto>(`/admin/integrations/${id}`),
    serverApiFetch<IntegrationCompanyMappingDto[]>(
      `/admin/integrations/${id}/mappings`,
    ),
    serverApiFetch<IntegrationSyncRunDto[]>(
      `/admin/integrations/${id}/runs`,
    ),
    serverApiFetch<{ drivers: DriverDescriptor[] }>(
      '/admin/integrations/drivers',
    ),
  ]);

  const integration = throwUnlessFound(intRes, `/admin/integrations/${id}`);
  const mappings = mappingsRes.data ?? [];
  const runs = runsRes.data ?? [];
  const drivers = driversRes.data?.drivers ?? [];
  const driver = drivers.find((d) => d.key === integration.driver) ?? null;

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Integrations', href: '/admin/integrations' },
          { label: integration.name },
        ]}
        title={integration.name}
        description={
          driver?.description ??
          `Driver: ${integration.driver}. Manage credentials, organization mappings, and sync history below.`
        }
      />
      <PageBody>
        <Panel noPad>
          <IntegrationTabs
            initialTab={sp.tab ?? 'creds'}
            integration={integration}
            mappings={mappings}
            runs={runs}
            driver={driver}
          />
        </Panel>
      </PageBody>
    </>
  );
}
