'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '../../../../lib/api';
import {
  Btn,
  Dialog,
  Icon,
  MenuDivider,
  MenuItem,
  OverflowMenu,
  StarGlyph,
  useStarToggle,
  useToast,
} from '../../../../components/ui';
import type { CompanyDetail } from '../../../../lib/server-api';
import { capitalize, lower } from '../../../../lib/term';
import { useTerm } from '../../../../lib/term-context';

/**
 * The company home page's whole action cluster, rendered into
 * `TopBar`'s `right` slot.
 *
 * This replaces the sub-row that used to carry four equal-weight
 * buttons (Star, Preview portal, Edit, Archive). Unlike assets,
 * articles, and passwords, nothing here is promoted to a primary
 * control: Edit only hands off to the Settings route, and none of the
 * four is the action an operator opened the page for — they came to
 * read the overview. So the row is the overflow menu alone.
 *
 * Edit stays available while archived, which is why the archived state
 * does not promote Restore into the row the way it does on the other
 * detail pages — there is no empty primary slot to fill.
 *
 * No attention dot: the one thing worth reviewing here is the archived
 * state, and that is a `Tag` beside the name in `DetailTitle`, still
 * visible with the menu closed.
 *
 * Copies `ArticleHeaderActions` in
 * `apps/web/src/app/admin/companies/[id]/articles/[articleId]/article-header-actions.tsx`.
 */
export function CompanyActions({
  company,
  manage,
}: {
  company: CompanyDetail;
  /** Write access to this company, derived server-side. */
  manage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const term = useTerm();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const { starred, toggle } = useStarToggle({
    entityType: 'company',
    entityId: company.id,
    initialStarred: company.isStarred,
  });

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
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <OverflowMenu>
        {(close) => (
          <>
            <MenuItem
              glyph={<StarGlyph filled={starred} size={14} />}
              onClick={() => {
                void toggle();
              }}
            >
              {starred ? 'Starred' : 'Star'}
            </MenuItem>
            <MenuItem
              icon={Icon.ext}
              onClick={() => {
                // A `MenuItem` href renders an in-app `Link`; the portal
                // is a separate surface and has always opened in its own
                // tab, so this stays a button.
                window.open(
                  `/portal/${company.slug}`,
                  '_blank',
                  'noopener,noreferrer',
                );
                close();
              }}
            >
              Preview portal
            </MenuItem>
            {manage && (
              <MenuItem
                icon={Icon.edit}
                href={`/admin/companies/${company.id}/settings`}
                onClick={close}
              >
                Edit
              </MenuItem>
            )}
            {manage && <MenuDivider />}
            {manage && (
              <MenuItem
                icon={company.archivedAt ? Icon.check : Icon.archive}
                onClick={() => {
                  setArchiveOpen(true);
                  close();
                }}
              >
                {company.archivedAt ? 'Restore' : 'Archive'}
              </MenuItem>
            )}
          </>
        )}
      </OverflowMenu>

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
    </div>
  );
}
