'use client';

import { useCallback } from 'react';
import type { DomainCheck, MonitoredDomain } from '../../lib/server-api';
import { domainToMarkdown } from '../../lib/domain-format';
import { useChatDomainPageContext } from './use-chat-page-context';

/**
 * Bridge that lets the server-rendered domain detail page register
 * itself with the chat panel. The domain (+ latest check, when
 * available) is captured at server-render time and projected to
 * markdown on demand via the same `domainToMarkdown` helper used for
 * @-mentioned domains, so the auto-attached "current domain" looks
 * identical to a manually @-mentioned one in the LLM payload.
 */
export function DomainChatContext({
  domain,
  latestCheck,
}: {
  domain: MonitoredDomain;
  latestCheck: DomainCheck | null;
}) {
  const getMarkdown = useCallback((): string => {
    try {
      return domainToMarkdown(domain, latestCheck).markdown;
    } catch {
      return '';
    }
  }, [domain, latestCheck]);

  useChatDomainPageContext({
    companyId: domain.companyId,
    domainId: domain.id,
    hostname: domain.hostname,
    getMarkdown,
  });
  return null;
}
