/**
 * Minimal ambient declaration for `css-tree`, which ships no types of
 * its own.
 *
 * `@types/css-tree` exists but its latest is 2.3.11 against a 3.2.1
 * runtime — a major behind, which is exactly the skew that types
 * something wrongly and quietly. This declares only the two functions
 * the diagram CSS gate calls, and its shapes are pinned by
 * `CssParserLike` in `src/browser/diagram-svg.ts`, so the declaration
 * and the contract cannot drift apart without a compile error.
 *
 * Deliberately no `generate`: the gate VALIDATES and never edits an AST,
 * so serialization is not in the trust path. Adding it here would invite
 * a mutate-and-re-emit implementation, which is the design this file's
 * absence of an API is meant to prevent.
 *
 * Three copies of this file exist — here, `apps/web/types/`, and
 * `apps/mobile/types/` — because each package resolves `css-tree`
 * independently. Keep them identical.
 */
declare module 'css-tree' {
  /** Only the fields the gate reads. css-tree nodes carry far more. */
  export interface CssNode {
    type: string;
    name?: string;
    value?: unknown;
    children?: unknown;
  }

  export function parse(
    css: string,
    options?: { context?: string; positions?: boolean },
  ): CssNode;

  export function walk(ast: CssNode, visit: (node: CssNode) => void): void;
}
