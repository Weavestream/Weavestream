import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  requireMe,
  getPasswordDetail,
} from '../../../../../lib/server-api';
import { resolvePortalCompany } from '../../../../../lib/portal-company';
import {
  PageBody,
  PageHeader,
} from '../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../components/ui';
import { PasswordRevealField } from '../../../../../components/passwords/password-reveal-field';
import { TotpCode } from '../../../../../components/passwords/totp-code';

export const metadata: Metadata = { title: 'Password' };

/**
 * Portal password detail (read-only).
 *
 * Mirrors the admin detail page, minus the edit/archive affordances
 * and the version history panel. Reveal + TOTP flows are identical —
 * same throttles, same auditing.
 */
export default async function PortalPasswordDetailPage({
  params,
}: {
  params: Promise<{ companySlug: string; passwordId: string }>;
}) {
  const { companySlug, passwordId } = await params;
  const me = await requireMe();
  const company = await resolvePortalCompany(me, companySlug);

  const password = await getPasswordDetail(company.id, passwordId);
  if (!password) notFound();

  return (
    <>
      <PageHeader
        crumbs={[
          { label: company.name, href: `/portal/${companySlug}` },
          { label: 'Passwords', href: `/portal/${companySlug}/passwords` },
          { label: password.name },
        ]}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {password.name}
            {password.requireReasonToView && (
              <Tag tone="warn">reason required</Tag>
            )}
          </span>
        }
      />
      <PageBody>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            maxWidth: 640,
          }}
        >
          <Panel title="Credentials">
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '120px 1fr',
                rowGap: 12,
                columnGap: 16,
                fontSize: 13,
              }}
            >
              <Label>Username</Label>
              <code style={{ fontFamily: 'var(--font-mono)' }}>
                {password.username ?? '—'}
              </code>

              <Label>Password</Label>
              <PasswordRevealField
                companyId={company.id}
                passwordId={password.id}
                requiresReason={password.requireReasonToView}
                resetKey={password.updatedAt}
              />

              {password.hasTotp && (
                <>
                  <Label>TOTP</Label>
                  <TotpCode
                    companyId={company.id}
                    passwordId={password.id}
                    resetKey={password.updatedAt}
                  />
                </>
              )}

              <Label>URL</Label>
              <div>
                {password.url ? (
                  <a
                    href={password.url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)', wordBreak: 'break-all' }}
                  >
                    {password.url}
                  </a>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>—</span>
                )}
              </div>
            </div>
          </Panel>

          {password.notes != null && (
            <Panel title="Notes">
              <pre
                style={{
                  fontFamily: 'inherit',
                  fontSize: 13,
                  color: 'var(--text)',
                  whiteSpace: 'pre-wrap',
                  margin: 0,
                }}
              >
                {typeof password.notes === 'string'
                  ? password.notes
                  : flattenNotes(password.notes)}
              </pre>
            </Panel>
          )}
        </div>
      </PageBody>
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: 'var(--muted)',
        fontFamily: 'var(--font-mono)',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        fontSize: 11,
        paddingTop: 6,
      }}
    >
      {children}
    </div>
  );
}

function flattenNotes(value: unknown): string {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return;
    const node = n as { text?: string; content?: unknown[]; type?: string };
    if (typeof node.text === 'string') out.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
    if (node.type === 'paragraph' || node.type === 'heading') out.push('');
  };
  walk(value);
  return out.join('\n').trim();
}
