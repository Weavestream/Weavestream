import { notFound, redirect } from 'next/navigation';
import { AuthShell } from '../../../../components/shell/auth-shell';
import { getMe } from '../../../../lib/server-api/auth';
import { CONSENT_UID } from '../../../../lib/safe-next-path';
import { ConsentClient } from './consent-client';

/**
 * Consent for a remote MCP connection (ChatGPT, Claude). The OAuth
 * authorization server sends the browser here. It needs a normal Weavestream
 * session; without one, the user signs in (with MFA) and comes back.
 */
export default async function ConsentPage({ params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  if (!CONSENT_UID.test(uid)) notFound();
  const me = await getMe();
  if (!me) redirect(`/login?next=${encodeURIComponent(`/oauth/consent/${uid}`)}`);
  return (
    <AuthShell title="Connect an AI app">
      <ConsentClient uid={uid} />
    </AuthShell>
  );
}
