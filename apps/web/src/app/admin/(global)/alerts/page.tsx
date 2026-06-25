import { redirect } from 'next/navigation';
import { getAlerts, requireMe } from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel } from '../../../../components/ui';
import { AlertsAdminClient } from './alerts-admin-client';

/**
 * Hudu-style "Alerts" admin page. Operators with `ALERT_MANAGE`
 * configure email-driven notifications for the five supported alert
 * types (single expiration, expiration list, website down, record
 * event, password event). RECORD_EVENT and PASSWORD_EVENT fire
 * synchronously off the audit log; the other three are evaluated by
 * the BullMQ `alerts:scan` cron.
 */
export default async function AlertsPage() {
  const me = await requireMe();
  if (!hasCapability(me, 'ALERT_MANAGE')) redirect('/admin');

  const alerts = await getAlerts();

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'Alerts' },
        ]}
        title="Alerts"
        description="Configure email alerts for expirations, website availability, and record-lifecycle events. Real-time alerts fire from the audit log; expiration and uptime alerts run on a scheduled scan."
      />
      <PageBody>
        <Panel noPad>
          <AlertsAdminClient initialAlerts={alerts} />
        </Panel>
      </PageBody>
    </>
  );
}
