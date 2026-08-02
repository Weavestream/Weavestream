import { useCallback, useEffect, useState } from 'react';
import { sessionUsable } from '../lib/auth';
import { AuthScreen } from '../components/AuthScreen';
import { Button, Subtitle, Title } from '../components/primitives';
import { ErrorBanner } from '../components/states';

/**
 * Hand-off for accounts that have never enrolled in MFA.
 *
 * **Why mobile does not enrol.** Enrolment is the only branch that puts
 * secrets on the client — a TOTP seed and one-time backup codes that
 * cannot be re-issued from this screen. It also needs a state machine
 * that survives the user leaving the app to reach their authenticator,
 * which a naive clear-on-background rule would destroy. That is Phase 2
 * work, not foundation work. Re-authentication — the reason auth lives
 * in `/m` at all — is unaffected: it never issues a secret.
 *
 * **Why a resume button works without a re-login.** `mfaSetupRequired`
 * derives from `user.mfaEnforcementCompletedAt`, a *user* column rather
 * than a session flag, and `AuthGuard` reloads the user row from the
 * database on every request instead of trusting the access token's
 * claims. So the moment enrolment completes in the desktop tab, the very
 * next request from this device passes. No token-TTL lag, no re-login.
 *
 * The visibility listener covers the common case (user switches back to
 * the PWA); the button covers the case where the browser does not fire
 * one, and sign-out is the escape hatch if the state is genuinely stuck.
 */
export function MfaSetupHandoffScreen({
  onReady,
  onSignOut,
}: {
  onReady: () => void;
  onSignOut: () => Promise<{ ok: boolean; message?: string }>;
}) {
  const [checking, setChecking] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const recheck = useCallback(async () => {
    setChecking(true);
    const ok = await sessionUsable();
    setChecking(false);
    if (ok) onReady();
    else setStalled(true);
  }, [onReady]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void recheck();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [recheck]);

  return (
    <AuthScreen>
      <Title>Finish setup on desktop</Title>
      <Subtitle>
        Your account needs two-factor authentication before you can use
        Weavestream. Set it up on the desktop app, then come back here.
      </Subtitle>

      <div className="flex flex-col gap-3">
        <a
          href="/mfa/setup"
          // Opens outside the installed app deliberately: /mfa/setup is
          // outside the /m/ manifest scope, and forcing a new context
          // makes that explicit rather than letting the browser decide.
          target="_blank"
          rel="noopener noreferrer"
          className="flex h-control w-full items-center justify-center rounded-pill bg-accent-fill text-body font-semibold text-accent-fill-ink"
        >
          Open desktop setup
        </a>

        <Button kind="secondary" onClick={() => void recheck()} disabled={checking}>
          {checking ? 'Checking…' : 'I&rsquo;ve finished setting up'}
        </Button>

        {stalled && (
          <>
            <ErrorBanner title="Still not set up. Finish enrolment in the desktop tab, then try again." />
            <Button
              kind="secondary"
              onClick={async () => {
                setSignOutError(null);
                const result = await onSignOut();
                // Only the caller navigates, and only on success. A
                // failed sign-out that still routed to login would tell
                // the user they are signed out while the HttpOnly
                // session is live.
                if (!result.ok) setSignOutError(result.message ?? null);
              }}
            >
              Sign out
            </Button>
            {signOutError && <ErrorBanner title={signOutError} />}
          </>
        )}
      </div>
    </AuthScreen>
  );
}
