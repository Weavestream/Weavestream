'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../../../../lib/api';
import { companyAccent } from '../../../../lib/company-format';
import type { CompanyParentRef } from '../../../../lib/server-api/companies';
import { lower } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';
import { CompanyMark, MenuItem, OverflowMenu, Tag } from '../../../../components/ui';

/**
 * The Classification panel's "2 sites" count, as a menu of the child
 * companies behind it. The rows are fetched on open rather than shipped
 * with the overview: the detail read is shared by every company page,
 * and most visits never open this.
 *
 * The list is every direct child, archived ones included, so it always
 * agrees with the count — see `CompaniesService.listChildren` for why it
 * is not filtered by the viewer's access.
 */
export function ChildrenMenu({ companyId, count }: { companyId: string; count: number }) {
  const term = useTerm();
  const noun = count === 1 ? lower(term.one) : lower(term.other);
  return (
    <OverflowMenu label={`Child ${lower(term.other)}`} trigger={`${count} ${noun}`} align="start">
      {(close) => <ChildrenRows companyId={companyId} count={count} onNavigate={close} />}
    </OverflowMenu>
  );
}

/**
 * Mounted only while the menu is open, so every open refetches — a
 * child added in another tab shows up without a page reload.
 */
function ChildrenRows({
  companyId,
  count,
  onNavigate,
}: {
  companyId: string;
  count: number;
  onNavigate: () => void;
}) {
  const term = useTerm();
  const [items, setItems] = useState<CompanyParentRef[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ items: CompanyParentRef[] }>(`/companies/${companyId}/children`, {
      signal: controller.signal,
    })
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.ok) setItems(res.data?.items ?? []);
        else setFailed(true);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [companyId]);

  if (failed) {
    return <div style={noteStyle}>Could not load child {lower(term.other)}.</div>;
  }
  if (items === null) return <div style={noteStyle}>Loading…</div>;

  return (
    <>
      {items.map((child) => (
        <MenuItem
          key={child.id}
          href={`/admin/companies/${child.id}`}
          onClick={onNavigate}
          glyph={<CompanyMark name={child.name} color={companyAccent(child.id)} size={22} />}
          trailing={child.archivedAt ? <Tag tone="warn">archived</Tag> : undefined}
        >
          {child.name}
        </MenuItem>
      ))}
      {items.length < count && (
        <div style={noteStyle}>
          Showing the first {items.length} of {count}.
        </div>
      )}
    </>
  );
}

const noteStyle = {
  padding: '6px 8px',
  fontSize: 12,
  color: 'var(--muted)',
} as const;
