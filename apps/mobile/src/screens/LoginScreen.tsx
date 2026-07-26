import { useState, type FormEvent } from 'react';
import { login } from '../lib/auth';
import { Button, ErrorNote, Field, Input, Screen, Subtitle, Title } from '../components/ui';

/**
 * Login, in-scope at `/m/login`.
 *
 * Living inside `/m` is not cosmetic. Manifest scope matching is a path
 * prefix, so an installed PWA scoped to `/m/` that navigated to the
 * desktop `/login` would leave its scope and open in a browser tab — the
 * technician would re-authenticate in Safari while the installed app sat
 * there still expired. That is the whole reason auth moved in-scope for
 * Phase 0.
 *
 * The endpoints are the existing ones, untouched: rate limiting, account
 * lockout, MFA enforcement, and IP rules all stay server-side. This adds
 * no authorization surface.
 */
export function LoginScreen({
  onDone,
}: {
  onDone: (next: 'app' | 'mfa-challenge' | 'mfa-setup') => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const outcome = await login(email, password);
    setPending(false);

    switch (outcome.kind) {
      case 'ok':
        return onDone('app');
      case 'mfa-challenge':
        return onDone('mfa-challenge');
      case 'mfa-setup':
        return onDone('mfa-setup');
      case 'error':
        // Stays on this screen. A 401 here is a wrong password, not a
        // dead session — see query-client.ts for why that distinction
        // is structural rather than a status check.
        return setError(outcome.message);
    }
  }

  return (
    <Screen>
      <Title>Sign in</Title>
      <Subtitle>Weavestream for field technicians</Subtitle>

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {error && <ErrorNote>{error}</ErrorNote>}

        <Button type="submit" disabled={pending}>
          {pending ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </Screen>
  );
}
