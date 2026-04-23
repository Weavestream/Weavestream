import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  getCompanyDetail,
  getCompanyPasswordFolders,
  getMe,
  getPasswordDetail,
  getSettings,
  listPasswordVersions,
  throwUnlessFound,
} from '../../../../../../lib/server-api';
import { canManage } from '../../../../../../lib/roles';
import {
  PageBody,
  PageHeader,
} from '../../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import { PasswordDetailClient } from './password-detail-client';

export const metadata: Metadata = { title: 'Password' };

/**
 * Phase 10 — Admin password detail.
 *
 * Server-rendered scaffold: all plaintext (password, TOTP secret,
 * decrypted notes) is fetched by the client components when the user
 * explicitly requests it. The server only receives non-secret fields
 * and the decrypted `notes` JSON, which is returned by `GET /:id`.
 */
export default async function PasswordDetailPage({
  params,
}: {
  params: Promise<{ id: string; passwordId: string }>;
}) {
  const { id: companyId, passwordId } = await params;
  const me = (await getMe())!;
  const settings = await getSettings();
  const term = buildTerm(settings);

  const [companyRes, password, folders, versions] = await Promise.all([
    getCompanyDetail(companyId),
    getPasswordDetail(companyId, passwordId),
    getCompanyPasswordFolders(companyId),
    listPasswordVersions(companyId, passwordId),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);
  if (!password) notFound();

  const manage = canManage(me.role);
  const folder = password.folderId
    ? folders.find((f) => f.id === password.folderId)
    : null;

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(
          term,
          company,
          { label: 'Passwords', href: `/admin/companies/${companyId}/passwords` },
          { label: password.name },
        )}
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            {password.color && (
              <span
                aria-hidden
                style={{
                  display: 'inline-block',
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: password.color,
                }}
              />
            )}
            {password.name}
            {password.assetId && (
              <Tag tone="accent">
                embedded on{' '}
                <Link
                  href={`/admin/companies/${companyId}/assets/${password.assetId}`}
                  style={{ color: 'inherit', textDecoration: 'underline' }}
                >
                  asset
                </Link>
              </Tag>
            )}
            {password.visibleToClients ? (
              <Tag tone="accent">client-visible</Tag>
            ) : (
              <Tag tone="outline">internal</Tag>
            )}
            {password.requireReasonToView && (
              <Tag tone="warn">reason required</Tag>
            )}
            {password.archivedAt && <Tag tone="default">archived</Tag>}
          </span>
        }
      />
      <PageBody>
        <PasswordDetailClient
          companyId={companyId}
          password={password}
          versions={versions}
          folders={folders}
          canManage={manage}
          folderName={folder?.name ?? null}
          me={{ id: me.id, role: me.role }}
          generatorDefaults={settings.passwordGeneratorDefaults}
        />
      </PageBody>
    </>
  );
}
