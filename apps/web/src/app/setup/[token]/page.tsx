import { API_INTERNAL_URL } from '../../../lib/server-api';
import { AuthShell } from '../../../components/shell/auth-shell';
import SetupForm from './setup-form';

type InviteLookup =
  | { valid: false }
  | { valid: true; email: string; name: string; expiresAt: string };

async function lookup(token: string): Promise<InviteLookup | null> {
  try {
    const res = await fetch(
      `${API_INTERNAL_URL}/api/v1/auth/invite/${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return { valid: false };
    return (await res.json()) as InviteLookup;
  } catch {
    return null;
  }
}

export default async function SetupPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = await lookup(token);

  if (!result || result.valid === false) {
    return (
      <AuthShell
        title="Setup link expired"
        subtitle="This invite is no longer valid. Ask your administrator to send a new one."
      >
        <div style={{ textAlign: 'center' }}>
          <a
            href="/login"
            style={{
              fontSize: 13,
              color: 'var(--accent)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            back to sign in →
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Welcome to Weavestream"
      subtitle={
        <>
          Set a password for <strong style={{ color: 'var(--text)' }}>{result.email}</strong>.
          You'll enable two-factor auth on the next step.
        </>
      }
    >
      <SetupForm token={token} name={result.name} />
    </AuthShell>
  );
}
