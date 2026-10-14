import { AuthShell } from '../../../components/shell/auth-shell';
import MfaSetupClient from './mfa-setup-client';
import { safeNextPath } from '../../../lib/safe-next-path';

export default async function MfaSetupPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <AuthShell
      title="Two-factor setup"
      subtitle="Required for every account. Scan the code with any TOTP app."
    >
      <MfaSetupClient next={next} />
    </AuthShell>
  );
}
