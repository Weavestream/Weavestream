'use client';

import { useEffect } from 'react';
import { useChatPanel } from './chat-panel-provider';

/**
 * Broadcasts the active companyId to the chat panel for the lifetime
 * of the calling component. Mounted once at the company shell level
 * so every page under `/admin/companies/[id]/**` (and the portal
 * equivalent) exposes a companyId to the @-mention picker without
 * needing the richer article-page snapshot.
 *
 * Article-specific pages still register their own `pageContext` via
 * `useChatPageContext`; the resolver prefers that snapshot when it's
 * present so tool-call scoping behavior is unchanged.
 */
export function CompanyChatContext({ companyId }: { companyId: string }) {
  const { registerCompanyContext } = useChatPanel();
  useEffect(() => {
    return registerCompanyContext(companyId);
  }, [companyId, registerCompanyContext]);
  return null;
}
