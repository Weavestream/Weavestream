'use client';

/**
 * Mounts the Phase 6 palette in a shell (admin / company / portal)
 * and wires the global keyboard shortcuts:
 *
 *   ⌘K / Ctrl+K   — open from anywhere
 *   /             — open when focus is not in a text field
 *   Esc           — close (handled inside the palette)
 *
 * The trigger button in `TopBar` calls `useSearchPalette().open()`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { UserSearchDefaults } from '@weavestream/shared';
import { SearchPalette } from './search-palette';

type Ctx = {
  open: () => void;
  close: () => void;
  isOpen: boolean;
};

const SearchPaletteContext = createContext<Ctx | null>(null);

export function useSearchPalette(): Ctx {
  const v = useContext(SearchPaletteContext);
  if (!v) {
    // Returning a no-op context is friendlier than throwing — pages
    // that don't mount a shell (e.g. /login) still render without a
    // runtime crash.
    return { open: () => {}, close: () => {}, isOpen: false };
  }
  return v;
}

export function SearchPaletteProvider({
  children,
  scopedCompany,
  defaults,
}: {
  children: ReactNode;
  scopedCompany: { id: string; name: string } | null;
  defaults: UserSearchDefaults | null;
}) {
  const [open, setOpen] = useState(false);
  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // ⌘K / Ctrl+K — always opens, even when the focus is inside an
      // input field, matching every other palette in the industry.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen(true);
        return;
      }
      // `/` only triggers when focus is outside a text entry. A raw
      // document-level listener that fires on every keystroke would
      // swallow the slash key in articles, search inputs, and Tiptap
      // content — gate it on the active element.
      if (e.key === '/' && !isTextEntryFocused(e.target)) {
        e.preventDefault();
        setOpen(true);
        return;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const ctx = useMemo<Ctx>(
    () => ({ open: openPalette, close: closePalette, isOpen: open }),
    [open, openPalette, closePalette],
  );

  return (
    <SearchPaletteContext.Provider value={ctx}>
      {children}
      <SearchPalette
        open={open}
        onClose={closePalette}
        scopedCompany={scopedCompany}
        defaults={defaults}
      />
    </SearchPaletteContext.Provider>
  );
}

function isTextEntryFocused(target: EventTarget | null): boolean {
  const el =
    target instanceof HTMLElement
      ? target
      : (document.activeElement as HTMLElement | null);
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  // Tiptap wraps its editor as a contenteditable pm-root; `isContentEditable`
  // above catches it, but some cmdk inputs ship with data attrs — be
  // generous and treat `[role="textbox"]` the same way.
  if (el.getAttribute('role') === 'textbox') return true;
  return false;
}
