'use client';

import { useEffect, useState } from 'react';
import { useIsMobile } from './use-is-mobile';

/**
 * Below this the folder rail starts folded. The arithmetic behind it:
 * the app sidebar takes 248px, `PageBody` another 40, and the rail 221 —
 * 509px gone before a table starts. A dense list needs the rest, and the
 * rail is the only one of the three we can hand back.
 */
export const RAIL_COLLAPSE_PX = 1360;

/**
 * Folder-rail open/closed state, shared by every browser with a rail.
 *
 * The rail follows the viewport until the user says otherwise; their
 * choice then holds at every width until they change it back. On phones
 * neither applies — the rail is a tab there, not a column — so
 * `collapsed` is always false and the caller hides its toggle.
 *
 * @param storageKey per-surface localStorage key, so the passwords rail
 * and the articles rail remember their own answers.
 */
export function useRailCollapse(storageKey: string): {
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
} {
  const isMobile = useIsMobile();
  // The same media-query hook at a desktop threshold: true once the
  // window is too narrow to carry the rail and a full table at once.
  const isNarrow = useIsMobile(RAIL_COLLAPSE_PX);
  // `null` = follow the viewport; a boolean is a deliberate choice.
  const [choice, setChoice] = useState<boolean | null>(null);

  useEffect(() => {
    // Cannot be a lazy `useState` initialiser: there is no
    // `localStorage` during the server render, so reading it before
    // mount would hydrate against a value the server never saw.
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw === 'open') setChoice(false);
      else if (raw === 'closed') setChoice(true);
    } catch {
      // Blocked storage just means the rail follows the viewport.
    }
  }, [storageKey]);

  function setCollapsed(next: boolean) {
    setChoice(next);
    try {
      window.localStorage.setItem(storageKey, next ? 'closed' : 'open');
    } catch {
      // Non-fatal: the choice still holds for this page view.
    }
  }

  return { collapsed: !isMobile && (choice ?? isNarrow), setCollapsed };
}
