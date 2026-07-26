import { copyToClipboard, copyWithPromise } from '@weavestream/shared/browser';
import { scheduleClipboardClear } from './clipboard-guard';

/**
 * The single reveal-and-copy executor. Everything subtle about copying
 * a secret lives here so the screens can't get it wrong:
 *
 *  - **Must be called synchronously inside the tap handler.** The
 *    shared `copyWithPromise` queues a `ClipboardItem` against the
 *    current user-gesture token; ANY `await` between the tap and this
 *    call silently breaks copying on iOS. (`copy.spec.ts` pins this.)
 *
 *  - **The provider is memoized.** `copyWithPromise` may legitimately
 *    invoke its provider twice — once for the `ClipboardItem` path and
 *    again for the `writeText` fallback. Un-memoized, that is two
 *    reveal requests: two audit rows, two units of the 30/min budget,
 *    and a duplicated ReasonRequired round-trip.
 *
 *  - **The provider's rejection is captured.** `copyWithPromise`
 *    swallows provider errors and just returns `false`; without the
 *    capture, a ReasonRequired 400 would be indistinguishable from a
 *    clipboard failure and the reason sheet could never open
 *    reactively.
 */
export type CopySecretResult =
  | { ok: true }
  | { ok: false; error: unknown | null };

export function copySecret(opts: {
  /** Already-revealed value held in memory — copied directly. */
  cached?: string | null;
  /** Reveal call producing the secret; invoked at most once. */
  fetch?: () => Promise<string>;
}): Promise<CopySecretResult> {
  if (opts.cached != null) {
    return copyToClipboard(opts.cached).then((ok) => {
      if (!ok) return { ok: false as const, error: null };
      scheduleClipboardClear();
      return { ok: true as const };
    });
  }

  const fetchSecret = opts.fetch;
  if (!fetchSecret) {
    return Promise.resolve({ ok: false, error: null });
  }

  let shared: Promise<string> | null = null;
  let captured: unknown = null;
  const provider = (): Promise<string> => {
    // Memoized: both of copyWithPromise's possible invocations share
    // one request, and its rejection is recorded before the helper
    // swallows it.
    shared ??= fetchSecret().catch((err: unknown) => {
      captured = err;
      throw err;
    });
    return shared;
  };

  return copyWithPromise(provider).then((ok) => {
    if (!ok) return { ok: false as const, error: captured };
    scheduleClipboardClear();
    return { ok: true as const };
  });
}
