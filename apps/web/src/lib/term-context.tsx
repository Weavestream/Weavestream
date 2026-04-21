'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { DEFAULT_TERM, type Term } from './term';

/**
 * React context for tenant terminology. Kept in its own `'use client'`
 * module so server components can still import the pure helpers from
 * `./term` without crossing the client boundary (Turbopack flags any
 * server→client function call as a runtime error).
 *
 * Re-exports the server-safe pure helpers for client consumer
 * convenience, so a single import from `../lib/term-context` is
 * enough in any `'use client'` file that needs both `useTerm()` and
 * `lower()` / `capitalize()`.
 */

const TermContext = createContext<Term>(DEFAULT_TERM);

export function TermProvider({
  term,
  children,
}: {
  term: Term;
  children: ReactNode;
}) {
  // Memoize so consumers don't re-render on parent re-renders when the
  // term itself hasn't changed.
  const value = useMemo<Term>(
    () => ({ one: term.one, other: term.other, possessive: term.possessive }),
    [term.one, term.other, term.possessive],
  );
  return <TermContext.Provider value={value}>{children}</TermContext.Provider>;
}

export function useTerm(): Term {
  return useContext(TermContext);
}

// NOTE: do NOT re-export the server-safe helpers (`buildTerm`, `lower`,
// `capitalize`, `TERM_PRESETS`) from this module. `'use client'` at the
// top of this file taints every export — even transitive re-exports —
// as a client function, so any server component that reaches for
// `buildTerm` via `./term-context` would hit a runtime "cannot invoke
// a client function from the server" error. Server code must import
// those helpers from `./term` directly; client code can import from
// either.
export type { Term } from './term';
