'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Dialog,
  Icon,
  StarButton,
  useToast,
} from '../../../../components/ui';
import type { CompanyDetail } from '../../../../lib/server-api';
import { capitalize, lower } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';

/**
 * Toolbar for the company home page. After Phase 9a the "Edit" button
 * navigates to the dedicated Settings route instead of opening an
 * in-place dialog — editing the full set of Phase 9a fields is too
 * much for a modal. Archive / restore stays inline because it's a
 * single toggle.
 */
export function CompanyActions({ company }: { company: CompanyDetail }) {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function toggleArchive() {
    setPending(true);
    const path = company.archivedAt
      ? `/companies/${company.id}/restore`
      : `/companies/${company.id}`;
    const res = await apiFetch(path, {
      method: company.archivedAt ? 'POST' : 'DELETE',
    });
    setPending(false);
    if (!res.ok) {
      toast.push('Operation failed.', 'danger');
      return;
    }
    toast.push(
      company.archivedAt
        ? `${capitalize(term.one)} restored.`
        : `${capitalize(term.one)} archived.`,
      'ok',
    );
    setArchiveOpen(false);
    router.refresh();
  }

  return (
    <>
      <StarButton
        companyId={company.id}
        initialStarred={company.isStarred}
        showLabel
        iconSize={14}
      />
      <Btn
        kind="outline"
        size="md"
        icon={Icon.ext}
        onClick={() =>
          window.open(`/portal/${company.slug}`, '_blank', 'noopener,noreferrer')
        }
      >
        Preview portal
      </Btn>
      <Btn
        kind="outline"
        size="md"
        icon={Icon.edit}
        onClick={() => router.push(`/admin/companies/${company.id}/settings`)}
      >
        Edit
      </Btn>
      <Btn
        kind={company.archivedAt ? 'solid' : 'outline'}
        size="md"
        icon={company.archivedAt ? Icon.check : Icon.archive}
        onClick={() => setArchiveOpen(true)}
      >
        {company.archivedAt ? 'Restore' : 'Archive'}
      </Btn>

      <Dialog
        open={archiveOpen}
        onClose={() => !pending && setArchiveOpen(false)}
        title={
          company.archivedAt
            ? `Restore ${lower(term.one)}?`
            : `Archive ${lower(term.one)}?`
        }
        footer={
          <>
            <Btn kind="ghost" onClick={() => setArchiveOpen(false)} disabled={pending}>
              Cancel
            </Btn>
            <Btn
              kind={company.archivedAt ? 'primary' : 'danger'}
              loading={pending}
              onClick={toggleArchive}
            >
              {company.archivedAt ? 'Restore' : 'Archive'}
            </Btn>
          </>
        }
      >
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
          {company.archivedAt
            ? `${company.name} will reappear in navigation and active member lists.`
            : `${company.name} will be hidden from portals and new invites. Data, memberships, and audit logs are preserved and can be restored later.`}
        </p>
      </Dialog>
    </>
  );
}
