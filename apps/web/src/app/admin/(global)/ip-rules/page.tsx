import { redirect } from 'next/navigation';
import { getMe, listIpRules } from '../../../../lib/server-api';
import { hasCapability } from '../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel, Btn, Icon } from '../../../../components/ui';
import { IpRulesTable } from './ip-rules-table';

/**
 * Admin IP rules management page.
 *
 * Server-rendered first paint loads the rule list. The create/edit
 * dialogs are client components for interactivity.
 */
export default async function IpRulesPage() {
  const me = (await getMe())!;
  if (!hasCapability(me, 'IP_RULE_MANAGE')) redirect('/admin');

  const rules = await listIpRules();

  return (
    <>
      <PageHeader
        crumbs={[
          { label: 'Admin', href: '/admin' },
          { label: 'IP Rules' },
        ]}
        title="IP allow/deny rules"
        description="Define global IP allow/deny rules enforced before authentication. Rules are evaluated in priority order; the first match wins. If no rules match, access is allowed."
      />
      <PageBody>
        <Panel title={`${rules.length} rule${rules.length === 1 ? '' : 's'}`}>
          <IpRulesTable initialRules={rules} />
        </Panel>

        <div
          style={{
            padding: 12,
            background: 'var(--panel-2)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <strong style={{ color: 'var(--text)' }}>How rules work:</strong>
          <ul style={{ margin: '8px 0 0 16px', padding: 0 }}>
            <li>Rules are evaluated in priority order (lower number = first).</li>
            <li>The first matching rule wins: ALLOW proceeds to login, DENY blocks immediately.</li>
            <li>If no rules match, access is allowed (default-allow policy).</li>
            <li>Supports single IPs (192.168.1.1) or CIDR ranges (10.0.0.0/8).</li>
          </ul>
        </div>
      </PageBody>
    </>
  );
}
