'use client';

import { useEffect, useRef } from 'react';
import {
  useChatPanel,
  type ChatPageContextSnapshot,
} from './chat-panel-provider';

/**
 * Register the calling page as the active chat panel "page context".
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
    | (Omit<ChatPageContextSnapshot, 'kind'> & { kind?: 'article' })
    | null,
): void {
  const { registerPageContext, setPageDirty } = useChatPanel();
  const snapRef = useRef<ChatPageContextSnapshot | null>(null);
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
