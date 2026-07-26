import { useState, type FormEvent } from 'react';
import { verifyMfa } from '../lib/auth';
import { AuthScreen } from '../components/AuthScreen';
import { Button, Field, Input, Subtitle, Title } from '../components/primitives';
import { ErrorBanner } from '../components/states';

/**
 * MFA challenge — the re-authentication path, and the reason auth had to
 * move inside `/m` at all.
 *
 * This branch never issues a secret: `mfaChallengeRequired` implies the
 * user is already enrolled, so `firstTime` is false server-side and no
 * TOTP seed or backup code is returned. That is what makes it safe for
 * Phase 0 while enrolment waits for Phase 2, which has to deal with a
 * seed, a QR, one-time recovery codes, and a state machine that survives
 * the user switching apps to their authenticator.
 */
export function MfaChallengeScreen({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const outcome = await verifyMfa(token.trim());
    setPending(false);
    if (outcome.kind === 'ok') return onDone();
    // A wrong code returns 401 by design. Handled here so the user stays
    // put with "Invalid code" instead of being bounced to /m/login.
    setError(outcome.message);
  }

  return (
    <AuthScreen>
      <Title>Verify it&rsquo;s you</Title>
      <Subtitle>
        Enter the code from your authenticator app, or a backup code.
      </Subtitle>

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <Field label="Authenticator or backup code" htmlFor="totp">
          <Input
            id="totp"
            mono
            inputMode="text"
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Field>

        {error && <ErrorBanner title={error} />}

        <Button type="submit" disabled={pending}>
          {pending ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
    </AuthScreen>
  );
}
