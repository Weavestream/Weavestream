import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  DEFAULT_UI_ACCENT,
  DEFAULT_UI_THEME,
  uiAccentValues,
  type UiAccent,
  type UiPreferences,
  type UiTheme,
} from '@weavestream/shared';
import { apiFetch } from '../lib/api';
import { applyUiPrefs, persistLocalUiPrefs } from '../lib/ui-prefs';
import type { Me } from '../screens/TabShell';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

/**
 * Theme + accent picker (Phase 4), the mobile counterpart of desktop's
 * appearance form. Mobile idiom: instant apply, no Save button — every
 * tap paints immediately and persists via `PATCH /me/preferences`.
 *
 * ## Write serialization — the part that is easy to get wrong
 *
 * Rapid taps must not race: two in-flight PATCHes can commit out of
 * order SERVER-side, persisting the older preference while the UI shows
 * the newer one — a generation counter on responses would fix only the
 * UI half. So writes are single-flight with trailing-latest coalescing:
 * at most one PATCH is ever in flight; further taps only move
 * `desired`, and when the in-flight request settles, one follow-up
 * fires iff `desired` moved past what was confirmed. Requests are
 * strictly sequential from this client, so the server cannot see them
 * out of order, and a burst of taps costs at most two requests.
 *
 * Failure reverts to the last server-confirmed preference — but only
 * when nothing newer is already desired; otherwise the follow-up send
 * decides and an older failure can never clobber a newer success.
 *
 * Publication (`persistLocalUiPrefs`: DOM restamp + cookie +
 * canonical-shell re-pin, plus the `['me']` cache merge that
 * `RequireSession`'s sync effect reads) happens only when the settled
 * request IS the latest desired state. An intermediate confirmation
 * must not restamp the older theme while a newer tap is queued — the
 * trailing send publishes its own pair on success, and the revert
 * path publishes the confirmed pair on failure (covering the persist
 * its success skipped).
 */

const THEME_ORDER: readonly UiTheme[] = ['system', 'light', 'dark'];
const THEME_LABEL: Record<UiTheme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

function prefsEqual(a: UiPreferences, b: UiPreferences): boolean {
  return a.uiTheme === b.uiTheme && a.uiAccent === b.uiAccent;
}

export function AppearanceSheet({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const me = queryClient.getQueryData<Me>(['me']);
  const initial: UiPreferences = {
    uiTheme: me?.preferences?.uiTheme ?? DEFAULT_UI_THEME,
    uiAccent: me?.preferences?.uiAccent ?? DEFAULT_UI_ACCENT,
  };

  const [selection, setSelection] = useState<UiPreferences>(initial);
  const desiredRef = useRef<UiPreferences>(initial);
  const confirmedRef = useRef<UiPreferences>(initial);
  const inFlightRef = useRef(false);

  function select(next: Partial<UiPreferences>) {
    const target = { ...desiredRef.current, ...next };
    if (prefsEqual(target, desiredRef.current)) return;
    desiredRef.current = target;
    setSelection(target);
    applyUiPrefs(target);
    void pump();
  }

  /** DOM + cookie + shell re-pin + `['me']` cache, as one unit. */
  function publishConfirmed(prefs: UiPreferences): void {
    persistLocalUiPrefs(prefs);
    queryClient.setQueryData<Me>(['me'], (old) =>
      old
        ? {
            ...old,
            preferences: {
              showItemCounts: old.preferences?.showItemCounts ?? false,
              uiTheme: prefs.uiTheme,
              uiAccent: prefs.uiAccent,
            },
          }
        : old,
    );
  }

  async function pump(): Promise<void> {
    if (inFlightRef.current) return;
    const target = desiredRef.current;
    if (prefsEqual(target, confirmedRef.current)) return;
    inFlightRef.current = true;
    try {
      await apiFetch('/me/preferences', {
        method: 'PATCH',
        body: JSON.stringify({
          uiTheme: target.uiTheme,
          uiAccent: target.uiAccent,
        }),
      });
      confirmedRef.current = target;
      // Publish only when this confirmation IS the latest desired
      // state: restamping an intermediate pair would flip the visible
      // theme (and cookie, pinned shell, and cache) backwards while a
      // newer tap is queued. The follow-up send publishes its own pair
      // — or the revert below publishes this one if that send fails.
      if (prefsEqual(desiredRef.current, target)) {
        publishConfirmed(target);
      }
    } catch {
      // Revert only when nothing newer is already desired — the
      // follow-up send owns the outcome otherwise.
      if (prefsEqual(desiredRef.current, target)) {
        desiredRef.current = confirmedRef.current;
        setSelection(confirmedRef.current);
        // Full publication, not just a DOM apply: the confirmed pair
        // may have skipped its own persist above (it was intermediate
        // when it succeeded), and cookie/cache must land on what the
        // server actually holds.
        publishConfirmed(confirmedRef.current);
        toast.push('Couldn’t save appearance. Try again.', 'danger');
      }
    } finally {
      inFlightRef.current = false;
      if (!prefsEqual(desiredRef.current, confirmedRef.current)) {
        void pump();
      }
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Appearance">
      <div className="flex flex-col gap-5 pb-2">
        <div
          className="flex gap-1 rounded-field bg-panel p-1"
          role="radiogroup"
          aria-label="Theme"
        >
          {THEME_ORDER.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={selection.uiTheme === t}
              onClick={() => select({ uiTheme: t })}
              className={
                'h-12 flex-1 rounded-seg text-[15px] font-medium ' +
                (selection.uiTheme === t
                  ? 'bg-surface text-text shadow-seg'
                  : 'text-muted active:bg-panel-2')
              }
            >
              {THEME_LABEL[t]}
            </button>
          ))}
        </div>

        <div
          className="flex items-center justify-between px-1"
          role="radiogroup"
          aria-label="Accent color"
        >
          {uiAccentValues.map((a: UiAccent) => (
            // Desktop's trick: `data-accent` on the button itself makes
            // `var(--accent)` inside it resolve to that palette under
            // the CURRENT theme — the swatch shows exactly the color
            // the app would use, with no hex map to drift.
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={selection.uiAccent === a}
              aria-label={a}
              data-accent={a}
              onClick={() => select({ uiAccent: a })}
              className="flex h-11 w-11 items-center justify-center rounded-full"
              style={{
                background: 'var(--accent)',
                border:
                  selection.uiAccent === a
                    ? '2px solid var(--text)'
                    : '2px solid var(--line-2)',
                boxShadow:
                  selection.uiAccent === a
                    ? '0 0 0 3px var(--bg), 0 0 0 4px var(--accent-line)'
                    : 'none',
              }}
            />
          ))}
        </div>
      </div>
    </Sheet>
  );
}
