// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthShell } from '../../components/shell/auth-shell';
import LoginForm from './login-form';

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

export default function LoginPage() {
  return (
    <AuthShell
      title="Sign in"
      subtitle="Use your Weavestream credentials."
      footer={<span>v{VERSION}</span>}
    >
      <LoginForm />
    </AuthShell>
  );
}
