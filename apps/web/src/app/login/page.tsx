// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthShell } from '../../components/shell/auth-shell';
import LoginForm from './login-form';
import { safeNextPath } from '../../lib/safe-next-path';

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const next = safeNextPath((await searchParams).next);
  return (
    <AuthShell
      title="Sign in"
      //subtitle="Use your Weavestream credentials."
      footer={<span>v{VERSION}</span>}
    >
      <LoginForm next={next} />
    </AuthShell>
  );
}
