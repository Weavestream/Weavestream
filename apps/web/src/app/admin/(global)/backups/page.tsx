import { redirect } from 'next/navigation';
import {
  requireMe,
  listBackupConfigs,
  listBackupRuns,
} from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { BackupsAdminClient } from './backups-admin-client';

/**
 * Scheduled Postgres export admin page.
 *
 * Server-rendered first paint loads schedules and the most recent
 * runs; the client component below owns the create/edit dialogs,
 * "Run now" polling, and the History tab refresh loop.
 */
export default async function BackupsPage() {
  const me = await requireMe();
  if (!hasCapability(me, 'BACKUP_MANAGE')) redirect('/admin');

  const [configs, runs] = await Promise.all([
    listBackupConfigs(),
    listBackupRuns(),
  ]);

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Backups' },
        ]}
        title="Scheduled Postgres exports"
        description="Schedule full pg_dump exports of the application database. Dumps land in ${DATA_DIR}/backup on the Docker host. Operators must back up that directory along with ${DATA_DIR}/files for full disaster recovery — see the runbook for the restore command."
      />
      <PageBody>
        <Panel noPad>
          <BackupsAdminClient initialConfigs={configs} initialRuns={runs} />
        </Panel>
      </PageBody>
    </>
  );
}
