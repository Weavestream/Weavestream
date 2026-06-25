import { redirect } from 'next/navigation';
import type {
  CloudflareIpListDto,
  DriverDescriptor,
  IntegrationCompanyMappingDto,
  IntegrationDto,
  IntegrationSyncRunDto,
} from '@weavestream/shared';
import {
  requireMe,
  serverApiFetch,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { hasCapability } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel } from '../../../../../components/ui';
import { IntegrationTabs } from './integration-tabs';
import { SecurityIntegrationTabs } from './cloudflare/security-integration-tabs';

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
  const me = await requireMe();
  if (!hasCapability(me, 'INTEGRATION_MANAGE')) redirect('/admin');

  const [intRes, driversRes] = await Promise.all([
    serverApiFetch<IntegrationDto>(`/admin/integrations/${id}`),
    serverApiFetch<{ drivers: DriverDescriptor[] }>(
      '/admin/integrations/drivers',
    ),
  ]);

  const integration = throwUnlessFound(intRes, `/admin/integrations/${id}`);
  const drivers = driversRes.data?.drivers ?? [];
  const driver = drivers.find((d) => d.key === integration.driver) ?? null;
  const kind = driver?.capabilities.kind ?? 'pull';

  // Asset-import drivers fetch the per-tenant mappings and run history
  // up-front; security drivers (Cloudflare) instead need the registered
  // lists. Splitting the fetch by kind avoids hitting endpoints that
  // 400 for the wrong driver shape.
  const [mappingsRes, runsRes, cfListsRes] = await Promise.all([
    kind === 'pull'
      ? serverApiFetch<IntegrationCompanyMappingDto[]>(
          `/admin/integrations/${id}/mappings`,
        )
      : Promise.resolve({ data: [] as IntegrationCompanyMappingDto[] }),
    kind === 'pull'
      ? serverApiFetch<IntegrationSyncRunDto[]>(
          `/admin/integrations/${id}/runs`,
        )
      : Promise.resolve({ data: [] as IntegrationSyncRunDto[] }),
    kind === 'security'
      ? serverApiFetch<CloudflareIpListDto[]>(
          `/admin/integrations/${id}/cloudflare/lists`,
        )
      : Promise.resolve({ data: [] as CloudflareIpListDto[] }),
  ]);

  const mappings = mappingsRes.data ?? [];
  const runs = runsRes.data ?? [];
  const cloudflareLists = cfListsRes.data ?? [];

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
          `Driver: ${integration.driver}. Manage credentials below.`
        }
      />
      <PageBody>
        <Panel noPad>
          {kind === 'security' ? (
            <SecurityIntegrationTabs
              initialTab={sp.tab ?? 'creds'}
              integration={integration}
              driver={driver}
              cloudflareLists={cloudflareLists}
            />
          ) : (
            <IntegrationTabs
              initialTab={sp.tab ?? 'creds'}
              integration={integration}
              mappings={mappings}
              runs={runs}
              driver={driver}
            />
          )}
        </Panel>
      </PageBody>
    </>
  );
}
