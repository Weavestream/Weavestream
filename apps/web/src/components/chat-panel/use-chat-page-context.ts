'use client';

import { useEffect, useRef } from 'react';
import {
  useChatPanel,
  type ChatArticlePageContext,
} from './chat-panel-provider';

/**
 * Register the calling article page as the active chat panel "page
 * context".
 *
 * Behaviour:
 *  - On mount: registers the snapshot. If a context tab for this
 *    article already exists, it is reused; otherwise a new context
 *    tab is created (but only revealed once the user opens the panel
 *    — we don't pop the panel open on every article view).
 *  - On unmount: clears the snapshot but leaves the tab in place so a
 *    conversation in-progress survives a casual route change.
 *  - The `getMarkdown` closure is kept fresh — each render rebinds
 *    the snapshot, so sampling at send time reads the live editor /
 *    view state, not a stale value.
 */
export function useChatPageContext(
  snapshot:
    | (Omit<ChatArticlePageContext, 'kind'> & { kind?: 'article' })
    | null,
): void {
  const { registerPageContext, setPageDirty } = useChatPanel();
  const snapRef = useRef<ChatArticlePageContext | null>(null);
  // Always keep the freshest snapshot reachable for any in-flight
  // sendMessage; the provider closes over `snapRef.current` indirectly
  // via the `getMarkdown` thunk it captured at registration time.
  snapRef.current = snapshot
    ? { kind: 'article' as const, ...snapshot }
    : null;

  // Forward the dirty flag through a separate provider-level channel
  // so the Apply path can read it live without re-registering the
  // whole snapshot every keystroke.
  const dirty = snapshot?.isDirty ?? false;
  useEffect(() => {
    setPageDirty(dirty);
    return () => setPageDirty(false);
  }, [dirty, setPageDirty]);

  // Re-register whenever the identity of the page changes (company /
  // article id / title), but NOT on every render — most pages would
  // re-create the `getMarkdown` closure on every render and we don't
  // want to thrash the chat panel state.
  const keyParts = snapshot
    ? `${snapshot.companyId}|${snapshot.articleId ?? ''}|${snapshot.title}`
    : null;
  useEffect(() => {
    if (!snapshot) return;
    const cleanup = registerPageContext({
      kind: 'article',
      companyId: snapshot.companyId,
      articleId: snapshot.articleId,
      title: snapshot.title,
      // Thunk reads from the ref so the latest closure (with the
      // latest editor state) is sampled at send time.
      getMarkdown: () => snapRef.current?.getMarkdown() ?? '',
      // `isDirty` / `onBeforeAiApply` are forwarded through the ref;
      // the tool-call apply path reads them live at click time so a
      // form going dirty / clean between renders never desyncs the
      // chat panel.
      isDirty: snapshot.isDirty ?? false,
      onBeforeAiApply: () => snapRef.current?.onBeforeAiApply?.(),
      onAfterAiApply: (changes) =>
        snapRef.current?.onAfterAiApply?.(changes),
    });
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyParts, registerPageContext]);
}

/**
 * Register the calling asset detail page as the active chat panel
 * "page context". Same mount/unmount semantics as the article hook:
 * a fresh `getMarkdown` closure is rebound each render and sampled
 * at send time, so the asset row's latest fields (after a route-
 * refresh post-edit, say) are what the LLM sees.
 *
 * Unlike articles, the asset variant is purely read-only — no Apply
 * path, no dirty tracking — so its surface is intentionally smaller.
 */
export function useChatAssetPageContext(
  snapshot: {
    companyId: string;
    assetId: string;
    name: string;
    layoutName: string;
    getMarkdown: () => string;
  } | null,
): void {
  const { registerPageContext } = useChatPanel();
  const getMarkdownRef = useRef<() => string>(() => '');
  if (snapshot) getMarkdownRef.current = snapshot.getMarkdown;

  const keyParts = snapshot
    ? `${snapshot.companyId}|${snapshot.assetId}|${snapshot.name}|${snapshot.layoutName}`
    : null;
  useEffect(() => {
    if (!snapshot) return;
    const cleanup = registerPageContext({
      kind: 'asset',
      companyId: snapshot.companyId,
      assetId: snapshot.assetId,
      title: snapshot.name,
      layoutName: snapshot.layoutName,
      getMarkdown: () => getMarkdownRef.current(),
    });
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyParts, registerPageContext]);
}

/**
 * Register the calling domain detail page as the active chat panel
 * "page context". Same mount/unmount semantics as the asset hook: a
 * fresh `getMarkdown` closure is rebound each render and sampled at
 * send time, so the latest WHOIS/DNS/TLS check (after a route refresh
 * post "Check now", say) is what the LLM sees.
 *
 * Domains are purely read-only chat context — no Apply path, no
 * dirty tracking — so the surface stays small.
 */
export function useChatDomainPageContext(
  snapshot: {
    companyId: string;
    domainId: string;
    hostname: string;
    getMarkdown: () => string;
  } | null,
): void {
  const { registerPageContext } = useChatPanel();
  const getMarkdownRef = useRef<() => string>(() => '');
  if (snapshot) getMarkdownRef.current = snapshot.getMarkdown;

  const keyParts = snapshot
    ? `${snapshot.companyId}|${snapshot.domainId}|${snapshot.hostname}`
    : null;
  useEffect(() => {
    if (!snapshot) return;
    const cleanup = registerPageContext({
      kind: 'domain',
      companyId: snapshot.companyId,
      domainId: snapshot.domainId,
      title: snapshot.hostname,
      getMarkdown: () => getMarkdownRef.current(),
    });
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyParts, registerPageContext]);
}

/**
 * Register the calling ticket detail page as the active chat panel
 * "page context". Same mount/unmount semantics as the asset / domain
 * hooks. Tickets are real-time-fetched from the upstream system and
 * never persisted — the markdown is therefore captured at server-
 * render time and passed in verbatim; the closure just returns the
 * captured value. Provider is included so the chat panel pill (and
 * the system prompt) can attribute the ticket to the right system.
 */
export function useChatTicketPageContext(
  snapshot: {
    /** Resolved Weavestream company; null on the global admin surface
     *  when the upstream client id has no mapping. */
    companyId: string | null;
    ticketId: string;
    provider: string;
    subject: string;
    getMarkdown: () => string;
  } | null,
): void {
  const { registerPageContext } = useChatPanel();
  const getMarkdownRef = useRef<() => string>(() => '');
  if (snapshot) getMarkdownRef.current = snapshot.getMarkdown;

  const keyParts = snapshot
    ? `${snapshot.companyId ?? ''}|${snapshot.ticketId}|${snapshot.provider}|${snapshot.subject}`
    : null;
  useEffect(() => {
    if (!snapshot) return;
    const cleanup = registerPageContext({
      kind: 'ticket',
      companyId: snapshot.companyId,
      ticketId: snapshot.ticketId,
      provider: snapshot.provider,
      title: snapshot.subject,
      getMarkdown: () => getMarkdownRef.current(),
    });
    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyParts, registerPageContext]);
}
