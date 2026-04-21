import { AuthShell } from '../../../components/shell/auth-shell';
import MfaSetupClient from './mfa-setup-client';

export default function MfaSetupPage() {
  return (
    <AuthShell
      title="Two-factor setup"
      subtitle="Required for every account. Scan the code with any TOTP app."
    >
      <MfaSetupClient />
    </AuthShell>
  );
}
