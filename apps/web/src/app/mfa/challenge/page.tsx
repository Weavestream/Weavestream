import { AuthShell } from '../../../components/shell/auth-shell';
import MfaChallengeForm from './challenge-form';

export default function MfaChallengePage() {
  return (
    <AuthShell
      title="Two-factor code"
      subtitle="Enter the 6-digit code from your authenticator app."
    >
      <MfaChallengeForm />
    </AuthShell>
  );
}
