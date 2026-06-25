import { redirect } from 'next/navigation';
import { requireMe } from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { TagsAdminClient } from './tags-admin-client';

/**
 * Global Tag catalog. Tags follow the same global-identity model as
 * AssetLayout — one row, reusable across every company and every layout.
 * Inline creation is open to any authenticated operator (it happens on
 * the asset form), but rename and delete are gated on the `TAG_MANAGE`
 * capability so a typo-fix on a popular tag doesn't fall to anyone with
 * an asset edit button.
 */
export default async function TagsAdminPage() {
  const me = await requireMe();
  if (!hasCapability(me, 'TAG_MANAGE')) redirect('/admin');

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Tags' },
        ]}
        title="Tags"
        description="Global tag catalog — one identity reused across every company and layout. Renaming a tag updates every asset that references it on the next read; deleting drops the chip silently."
      />
      <PageBody>
        <Panel noPad>
          <TagsAdminClient />
        </Panel>
      </PageBody>
    </>
  );
}
