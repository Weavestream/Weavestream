/**
 * Human-readable message off an RFC 7807 problem body. The one extractor
 * for both apps: `apps/web` and `apps/mobile` read every API error through
 * it, so the same failure reads the same everywhere.
 *
 * Precedence is `detail` → `message` → `title`: the specific explanation
 * first, then a free-text `message` (the API's `ProblemExceptionFilter`
 * moves Nest's `message` into `detail`, but non-filter sources may still
 * send one), then the generic category. A field only counts when it is a
 * non-blank string, so a `""` or `"   "` falls through to the next
 * candidate rather than rendering as an empty error.
 *
 * A validation rejection (`ZodBody`) arrives as `detail: "ValidationError"`
 * plus an `issues` array; the code means nothing to a user, so the first
 * issue's `message` wins over every other field when one is present.
 *
 * Server errors (`status` ≥ 500) never fall back to `title`. The filter
 * strips `detail` from a 500, which would leave only "Internal Server
 * Error" — the caller's own wording ("Could not save settings.") says more.
 *
 * Returns `null` when nothing qualifies, leaving the fallback to the
 * caller: `problemMessage(res.problem) ?? 'Could not save.'`.
 */
export function problemMessage(problem: unknown): string | null {
  if (!problem || typeof problem !== 'object') return null;
  const p = problem as {
    detail?: unknown;
    message?: unknown;
    title?: unknown;
    status?: unknown;
    issues?: unknown;
  };
  if (Array.isArray(p.issues)) {
    const first = (p.issues[0] as { message?: unknown } | undefined)?.message;
    if (typeof first === 'string' && first.trim()) return first;
  }
  const serverError = typeof p.status === 'number' && p.status >= 500;
  const keys = serverError
    ? (['detail', 'message'] as const)
    : (['detail', 'message', 'title'] as const);
  for (const key of keys) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return null;
}

/**
 * Per-field messages off a `ZodBody` validation problem, so a form can
 * show each one under the field it belongs to instead of one message
 * somewhere else in the form. Keys are the top-level field of each
 * issue's dotted `path` (`retention.daily` → `retention`); the first
 * issue for a field wins. Issues with no path, or a blank message, are
 * skipped — read those through `problemMessage`.
 *
 * Built through a `Map` so a path such as `__proto__` or `constructor`
 * becomes an ordinary own key, never a prototype lookup or write.
 */
export function problemFieldErrors(problem: unknown): Record<string, string> {
  const byField = new Map<string, string>();
  const issues =
    problem && typeof problem === 'object'
      ? (problem as { issues?: unknown }).issues
      : undefined;
  if (Array.isArray(issues)) {
    for (const issue of issues) {
      if (!issue || typeof issue !== 'object') continue;
      const { path, message } = issue as { path?: unknown; message?: unknown };
      if (typeof path !== 'string' || typeof message !== 'string') continue;
      const field = path.split('.')[0];
      if (field && message.trim() && !byField.has(field)) byField.set(field, message);
    }
  }
  return Object.fromEntries(byField);
}
