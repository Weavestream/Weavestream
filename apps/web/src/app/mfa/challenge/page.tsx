import { AuthShell } from '../../../components/shell/auth-shell';
import MfaChallengeForm from './challenge-form';
import { safeNextPath } from '../../../lib/safe-next-path';

export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <AuthShell
      title="Two-factor code"
      subtitle="Enter the 6-digit code from your authenticator app."
    >
      <MfaChallengeForm next={next} />
    </AuthShell>
  );
}
