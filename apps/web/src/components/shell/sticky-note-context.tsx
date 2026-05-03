'use client';

import { createContext, useContext, type ReactNode } from 'react';

export type StickyNoteSeverity = 'INFO' | 'WARN' | 'CRITICAL';
export type StickyNoteValue = {
  text: string;
  severity: StickyNoteSeverity;
} | null;

const StickyNoteContext = createContext<StickyNoteValue>(null);

/**
 * Per-company sticky-note value, scoped to a CompanyShell subtree. The
 * `TopBar` reads it and renders the note as the first row inside its
 * already-sticky container, which keeps the banner and breadcrumbs
 * glued together as a single stacking block — separate sticky siblings
 * would overlap at `top: 0` and the breadcrumbs would slide behind the
 * banner on scroll.
 */
export function StickyNoteProvider({
  value,
  children,
}: {
  value: StickyNoteValue;
  children: ReactNode;
}) {
  return (
    <StickyNoteContext.Provider value={value}>
      {children}
    </StickyNoteContext.Provider>
  );
}

export function useStickyNote(): StickyNoteValue {
  return useContext(StickyNoteContext);
}
