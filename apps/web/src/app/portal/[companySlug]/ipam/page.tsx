import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';

export const metadata: Metadata = { title: 'IPAM' };

import {
  getMe,
  listSubnets,
  type SubnetRow,
} from '../../../../lib/server-api';
import { PageBody, PageHeader } from '../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../components/ui';

export default async function PortalIpamPage({
  params,
}: {
  params: Promise<{ companySlug: string }>;
}) {
  const { companySlug } = await params;
  const me = (await getMe())!;
  const membership = me.memberships.find((m) => m.company.slug === companySlug);
  if (!membership) notFound();
  const companyId = membership.company.id;

  const subnets = await listSubnets(companyId);

  return (
    <>
      <PageHeader
        crumbs={[{ label: membership.company.name }, { label: 'IPAM' }]}
        title="IPAM"
        description="IPv4 subnet overview for this company."
      />
      <PageBody>
        <Panel
          title={
            <span>
              {subnets.length} subnet{subnets.length === 1 ? '' : 's'}
            </span>
          }
          noPad
        >
          {subnets.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                color: 'var(--muted)',
                fontSize: 13,
              }}
            >
              No subnets configured for this company.
            </div>
          ) : (
            <SubnetList items={subnets} companySlug={companySlug} />
          )}
        </Panel>
      </PageBody>
    </>
  );
}

function SubnetList({
  items,
  companySlug,
}: {
  items: SubnetRow[];
  companySlug: string;
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <Th>Name</Th>
          <Th>CIDR</Th>
          <Th>VLAN</Th>
          <Th>Utilization</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((r) => {
          const pct =
            r.utilization.totalUsable > 0
              ? Math.round(
                  (r.utilization.claimed / r.utilization.totalUsable) * 100,
                )
              : 0;
          return (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ padding: '10px 12px' }}>
                <Link
                  href={`/portal/${companySlug}/ipam/${r.id}`}
                  style={{
                    color: 'var(--accent)',
                    textDecoration: 'none',
                    fontWeight: 500,
                  }}
                >
                  {r.name}
                </Link>
                {r.conflictCount > 0 && (
                  <Tag tone="danger" style={{ marginLeft: 6 }}>
                    {r.conflictCount} conflict{r.conflictCount > 1 ? 's' : ''}
                  </Tag>
                )}
              </td>
              <td
                style={{
                  padding: '10px 12px',
                  fontFamily: 'var(--font-mono, monospace)',
                }}
              >
                {r.cidr}
              </td>
              <td style={{ padding: '10px 12px' }}>{r.vlanId ?? '—'}</td>
              <td style={{ padding: '10px 12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{
                      flex: 1,
                      height: 6,
                      borderRadius: 3,
                      background: 'var(--surface-2)',
                      overflow: 'hidden',
                      minWidth: 60,
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        borderRadius: 3,
                        background:
                          pct > 90
                            ? 'var(--danger)'
                            : pct > 70
                              ? 'var(--warning, orange)'
                              : 'var(--accent)',
                      }}
                    />
                  </div>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--muted)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.utilization.claimed}/{r.utilization.totalUsable}
                  </span>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Th({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <th
      style={{
        padding: '8px 12px',
        textAlign: 'left',
        fontWeight: 500,
        fontSize: 12,
        color: 'var(--muted)',
        ...style,
      }}
    >
      {children}
    </th>
  );
}
