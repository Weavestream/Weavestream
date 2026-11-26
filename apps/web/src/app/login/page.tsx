// SPDX-License-Identifier: AGPL-3.0-or-later
import { AuthShell } from '../../components/shell/auth-shell';
import LoginForm from './login-form';
import { safeNextPath } from '../../lib/safe-next-path';

const VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; sso_error?: string | string[] }>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  const ssoError = typeof params.sso_error === 'string' ? params.sso_error : null;
  return (
    <AuthShell
      title="Sign in"
      //subtitle="Use your Weavestream credentials."
      footer={<span>v{VERSION}</span>}
    >
      <LoginForm next={next} ssoError={ssoError} />
    </AuthShell>
  );
}
