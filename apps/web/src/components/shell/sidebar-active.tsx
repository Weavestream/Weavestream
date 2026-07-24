'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

/**
 * Lets a page force which sidebar nav item is highlighted when URL
 * matching can't know the answer — e.g. an asset detail page lives at
 * `/assets/[assetId]` but belongs to a layout whose nav entry points
 * at `/layouts/[slug]`, so prefix matching would light up "All
 * assets" instead of the layout.
 *
 * The value and setter live in separate contexts so `SidebarActive`
 * (which only writes) doesn't re-render on every override change.
 */
const ValueCtx = createContext<string | undefined>(undefined);
const SetterCtx = createContext<Dispatch<
  SetStateAction<string | undefined>
> | null>(null);

export function SidebarActiveProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<string | undefined>(undefined);
  return (
    <SetterCtx.Provider value={setId}>
      <ValueCtx.Provider value={id}>{children}</ValueCtx.Provider>
    </SetterCtx.Provider>
  );
}

/** Consumed by `Sidebar`; undefined when no page mounted an override. */
export function useSidebarActiveOverride(): string | undefined {
  return useContext(ValueCtx);
}

/**
 * Mount from a page (renders nothing) to highlight the nav item with
 * this id while the page is on screen. Cleared on unmount; the
 * functional cleanup only resets the override if it still holds this
 * id, so an unmount racing a newer page's mount can't wipe the newer
 * value.
 */
export function SidebarActive({ id }: { id: string }) {
  const set = useContext(SetterCtx);
  useEffect(() => {
    if (!set) return undefined;
    set(id);
    return () => set((current) => (current === id ? undefined : current));
  }, [set, id]);
  return null;
}
