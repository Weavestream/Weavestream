import { initialsFromName, roleLabel } from '@weavestream/shared';
import { useState, useSyncExternalStore } from 'react';
import { AppearanceSheet } from '../components/AppearanceSheet';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import {
  Avatar,
  Card,
  GroupedList,
  GroupedRow,
  SectionLabel,
  Title,
} from '../components/primitives';
import { ErrorBanner } from '../components/states';
import {
  canPromptInstall,
  isIosSafariInstallTarget,
  isStandalone,
  promptInstall,
  subscribeInstallAvailability,
} from '../lib/install-prompt';
import { useOrgScope } from '../lib/org-scope';
import { useScopedNavigate } from '../lib/scoped-nav';
import { signOutAndReset } from '../lib/sign-out';
import { useMe, useOpenOrgSheet } from './TabShell';

/**
 * The overflow tab: account, org-scoped navigation that doesn't earn a
 * tab, roadmap signals, and sign out.
 *
 * **Three of the mock's four org-scoped rows are cut.** `Organization
 * home` has no screen behind it, `Recently viewed` has no per-user
 * recency anywhere server-side, and `Favorites` has no detail screens to
 * link to until Phase 2. A row that dead-ends is worse than an absent
 * row, so only `All organizations` ships — and it opens the switcher,
 * which does exist.
 *
 * The dashed IPAM / Domains / Photos chips stay: the handoff specifies
 * them as non-interactive roadmap signals, so rendering them as exactly
 * that is honest rather than a stub.
 */

const FUTURE_MODULES = [
  { icon: 'lan', label: 'IPAM' },
  { icon: 'language', label: 'Domains' },
  { icon: 'photo_library', label: 'Photos' },
] as const;

type InstallMode = 'prompt' | 'ios' | 'none';

/**
 * Which install affordance this browser gets: the captured Chromium
 * prompt, the iOS Safari instructions, or nothing (already installed,
 * or a browser with no install path).
 */
function installModeSnapshot(): InstallMode {
  if (isStandalone()) return 'none';
  if (canPromptInstall()) return 'prompt';
  if (isIosSafariInstallTarget()) return 'ios';
  return 'none';
}

export function MoreTab() {
  const me = useMe();
  const { currentOrg } = useOrgScope();
  const navigate = useScopedNavigate();
  const openOrgSheet = useOpenOrgSheet();
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // `beforeinstallprompt` often fires after mount — subscribe so the
  // row appears when the capture lands (and disappears on install).
  const installMode = useSyncExternalStore(
    subscribeInstallAvailability,
    installModeSnapshot,
  );

  const name = me?.name?.trim() || me?.email || 'Signed in';
  const role = me?.role ? roleLabel(me.role) : null;

  async function onSignOut() {
    setSignOutError(null);
    setSigningOut(true);
    const result = await signOutAndReset();
    // On success the helper hard-navigates, so this component is on its
    // way out and the flag never matters. On failure the session is still
    // live and the user must be told, not quietly returned to the tab.
    if (!result.ok) {
      setSigningOut(false);
      setSignOutError(result.message ?? 'Couldn’t sign out. Try again.');
    }
  }

  return (
    // `overflow-y-auto` even though the handoff wants this to fit a 667pt
    // device without scrolling: that holds at the default text size, and
    // large text, an error banner, or the keyboard must degrade to
    // scrolling rather than clipping the sign-out button off the screen.
    // `max-w-page mx-auto` = the shared content column every screen
    // uses (see tokens.css), and `pt-edge-t` because this screen has
    // no header above it to own the status-bar inset.
    <main className="mx-auto flex min-h-0 w-full max-w-page flex-1 flex-col gap-3.25 overflow-y-auto px-4.5 pb-5 pt-edge-t">
      <Title>More</Title>

      <Card className="flex items-center gap-3.25 p-3.25">
        <Avatar
          initials={initialsFromName(name)}
          size={46}
          shape="circle"
          tone="soft"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.75">
          <div className="truncate text-[18px] font-semibold tracking-[-0.015em] text-text">
            {name}
          </div>
          <div className="truncate font-mono text-meta text-muted">
            {role ? `${role} · profile` : 'profile'}
          </div>
        </div>
      </Card>

      <section className="flex flex-col gap-1.75">
        <SectionLabel>{currentOrg?.name ?? 'Organization'}</SectionLabel>
        <GroupedList>
          {/* Exit to the launcher (Phase 5b D1). Navigation only — the
              guard's arrival-clear effect owns leaving org context, so
              there is exactly one place that clears it. `replace`
              because "Home" is an exit, not a step to back out of. */}
          <GroupedRow
            icon="apartment"
            label="Home"
            onClick={() => navigate({ to: '/app', replace: true, orgId: null })}
          />
          <GroupedRow
            icon="dashboard"
            label="All organizations"
            onClick={openOrgSheet}
            last
          />
        </GroupedList>
      </section>

      <section className="flex flex-col gap-1.75">
        <SectionLabel>App</SectionLabel>
        <GroupedList>
          <GroupedRow
            icon="palette"
            label="Appearance"
            onClick={() => setAppearanceOpen(true)}
            last={installMode === 'none'}
          />
          {installMode !== 'none' && (
            <GroupedRow
              icon="install_mobile"
              label="Install app"
              onClick={
                installMode === 'prompt'
                  ? () => void promptInstall()
                  : () => setInstallHelpOpen(true)
              }
              last
            />
          )}
        </GroupedList>
      </section>

      <section className="flex flex-col gap-1.75">
        <SectionLabel>Room to grow · later</SectionLabel>
        <div className="flex flex-wrap gap-1.75">
          {FUTURE_MODULES.map((m) => (
            <div
              key={m.label}
              // Deliberately a div, not a button: these signal roadmap
              // and must not be focusable or tappable.
              aria-hidden
              className="flex h-10 items-center gap-1.75 rounded-btn border border-dashed border-line-3 bg-surface px-3.25 opacity-60"
            >
              <Icon name={m.icon} size={19} className="text-muted" />
              <span className="text-body font-medium text-text-2">
                {m.label}
              </span>
            </div>
          ))}
        </div>
      </section>

      {signOutError && <ErrorBanner title={signOutError} />}

      <button
        type="button"
        onClick={() => void onSignOut()}
        disabled={signingOut}
        className="mt-auto flex h-[52px] shrink-0 items-center justify-center gap-2.25 rounded-card border border-line bg-surface text-card-title font-semibold text-danger active:bg-panel-2 disabled:text-dim"
      >
        <Icon name="logout" size={21} />
        {signingOut ? 'Signing out…' : 'Sign out'}
      </button>

      <AppearanceSheet
        open={appearanceOpen}
        onClose={() => setAppearanceOpen(false)}
      />

      {/* iOS Safari has no install prompt API — the Share sheet is the
          only path, so the row opens instructions instead. */}
      <Sheet
        open={installHelpOpen}
        onClose={() => setInstallHelpOpen(false)}
        title="Install Weavestream"
      >
        <ol className="flex flex-col gap-3.25 pb-2">
          <li className="flex items-center gap-3.25">
            <Icon name="ios_share" size={24} className="shrink-0 text-accent" />
            <span className="text-body text-text">
              Tap the <span className="font-semibold">Share</span> button in
              Safari’s toolbar.
            </span>
          </li>
          <li className="flex items-center gap-3.25">
            <Icon
              name="install_mobile"
              size={24}
              className="shrink-0 text-accent"
            />
            <span className="text-body text-text">
              Choose <span className="font-semibold">Add to Home Screen</span>.
            </span>
          </li>
        </ol>
      </Sheet>
    </main>
  );
}
