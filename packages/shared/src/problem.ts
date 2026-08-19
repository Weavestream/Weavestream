/**
 * Human-readable message off an RFC 7807 problem body.
 *
 * Precedence is `detail` → `message` → `title`: the specific explanation
 * first, then the API's own free-text field, then the generic category. A
 * field only counts when it is a non-blank string, so a `""` or `"   "`
 * falls through to the next candidate rather than rendering as an empty
 * error. Returns `null` when nothing qualifies, leaving the fallback to the
 * caller — the desktop and mobile surfaces word theirs differently.
 *
 * Lives here rather than in either app because `apps/web` and `apps/mobile`
 * both had a byte-identical copy of this loop (mobile's docstring even said
 * it mirrored "desktop's `extractProblemMessage` precedence"), and
 * framework-free logic shared by both belongs in `packages/shared`.
 *
 * This is NOT the only precedence in the codebase — `lib/api-errors.ts`
 * carries the web-only `detail → title`, `message → detail → title` and
 * `detail → message` variants, which render differently and are deliberately
 * kept apart from this one.
 */
export function problemMessage(problem: unknown): string | null {
  if (!problem || typeof problem !== 'object') return null;
  const p = problem as { detail?: unknown; message?: unknown; title?: unknown };
  for (const key of ['detail', 'message', 'title'] as const) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}
