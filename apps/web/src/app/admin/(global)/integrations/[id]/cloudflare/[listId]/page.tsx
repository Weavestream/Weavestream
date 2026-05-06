import { redirect } from 'next/navigation';
import type {
  CloudflareIpListDto,
  IntegrationDto,
} from '@weavestream/shared';
import {
  getMe,
  serverApiFetch,
  throwUnlessFound,
} from '../../../../../../../lib/server-api';
import { hasCapability } from '../../../../../../../lib/roles';
import {
  PageBody,
  PageHeader,
} from '../../../../../../../components/shell/page-header';
import { Panel } from '../../../../../../../components/ui';
import { ListDetailView } from './list-detail-view';

export default async function CloudflareListDetailPage({
  params,
}: {
  params: Promise<{ id: string; listId: string }>;
}) {
  const { id, listId } = await params;
  const me = (await getMe())!;
  if (!hasCapability(me, 'INTEGRATION_MANAGE')) redirect('/admin');

  const [intRes, listRes] = await Promise.all([
    serverApiFetch<IntegrationDto>(`/admin/integrations/${id}`),
    serverApiFetch<CloudflareIpListDto>(
      `/admin/integrations/${id}/cloudflare/lists/${listId}`,
    ),
  ]);
  const integration = throwUnlessFound(intRes, `/admin/integrations/${id}`);
  const list = throwUnlessFound(
    listRes,
    `/admin/integrations/${id}/cloudflare/${listId}`,
  );

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Integrations', href: '/admin/integrations' },
          {
            label: integration.name,
            href: `/admin/integrations/${integration.id}?tab=lists`,
          },
          { label: list.name },
        ]}
        title={list.name}
        description={`Cloudflare IP list managed by Weavestream. ${list.entries.length} ${list.entries.length === 1 ? 'entry' : 'entries'}.`}
      />
      <PageBody>
        <Panel noPad>
          <ListDetailView integration={integration} initialList={list} />
        </Panel>
      </PageBody>
    </>
  );
}
