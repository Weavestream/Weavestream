'use client';

import { useState } from 'react';
import { Btn, Icon, Tag } from '../../../../../../components/ui';
import { HistoryPanel } from './history-panel';

/**
 * Small client-side wrapper around `HistoryPanel`. The article detail
 * page is a server component, so it can't own the panel's open/closed
 * state; this thin trigger does, and forwards the `companyId` /
 * `articleId` / capability flags onto the panel. The "draft in
 * progress" pill in the topbar lives here too so server↔client
 * boundaries stay tidy.
 */
export function HistoryTrigger({
  companyId,
  articleId,
  hasDraft,
  canRestore,
}: {
  companyId: string;
  articleId: string;
  hasDraft: boolean;
  canRestore: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {hasDraft && <Tag tone="warn">draft in progress</Tag>}
      <Btn
        kind="outline"
        size="md"
        icon={Icon.clock}
        onClick={() => setOpen(true)}
      >
        History
      </Btn>
      <HistoryPanel
        open={open}
        onClose={() => setOpen(false)}
        companyId={companyId}
        articleId={articleId}
        hasDraft={hasDraft}
        canRestore={canRestore}
      />
    </>
  );
}
