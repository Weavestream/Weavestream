import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  getAsset,
  getCompanyDetail,
  getCompanyPasswordFolders,
  requireMe,
  getPasswordDetailResult,
  getSettings,
  listPasswordVersions,
  throwUnlessFound,
} from '../../../../../../lib/server-api';
import { canWriteCompany, hasCapability } from '../../../../../../lib/roles';
import {
  PageBody,
  PageHeader,
} from '../../../../../../components/shell/page-header';
import { ErrorBanner, LayoutSwatch, Tag } from '../../../../../../components/ui';
import { buildTerm } from '../../../../../../lib/term';
import { companyCrumbs } from '../../../../../../lib/company-crumbs';
import {
  PasswordDetailClient,
  PasswordHeaderActions,
} from './password-detail-client';

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
  const me = await requireMe();
  const settings = await getSettings();
  const term = buildTerm(settings);

  const [companyRes, passwordResult, folders] = await Promise.all([
    getCompanyDetail(companyId),
    getPasswordDetailResult(companyId, passwordId),
    getCompanyPasswordFolders(companyId),
  ]);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  // A non-allowlisted operator gets 403 from the API (a CLIENT_USER gets
  // 404, handled by `notFound()` below so existence stays hidden). Render
  // a clear "no access" state rather than a bare not-found — the
  // credential is real, the viewer just isn't on its internal access
  // list. Return before fetching versions/asset so the denied path issues
  // no further (also-denied) requests.
  if (passwordResult.status === 403) {
    return (
      <>
        <PageHeader
          crumbs={companyCrumbs(
            term,
            company,
            {
              label: 'Passwords',
              href: `/admin/companies/${companyId}/passwords`,
            },
            { label: 'Restricted' },
          )}
          leading={<LayoutSwatch icon="lock" color="var(--muted)" size={48} />}
          title="Restricted credential"
        />
        <PageBody>
          <ErrorBanner
            tone="warn"
            title="You don't have access to this credential"
            detail="This credential is restricted to specific internal users. Ask a workspace admin to add you to its internal access list."
          >
            <Link
              href={`/admin/companies/${companyId}/passwords`}
              style={{ color: 'var(--accent)', textDecoration: 'underline' }}
            >
              Back to passwords
            </Link>
          </ErrorBanner>
        </PageBody>
      </>
    );
  }

  const password = passwordResult.data;
  if (!password) notFound();

  const [versions, linkedAsset] = await Promise.all([
    listPasswordVersions(companyId, passwordId),
    password.assetId
      ? getAsset(companyId, password.assetId)
      : Promise.resolve(null),
  ]);

  const manage = canWriteCompany(me, company.id);
  const manageInternalAccess = manage && hasCapability(me, 'MEMBERSHIP_MANAGE');
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
        leading={
          <LayoutSwatch
            icon="lock"
            color={password.color ?? 'var(--accent)'}
            size={48}
          />
        }
        title={password.name}
        description={
          <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {password.visibleToClients ? (
              <Tag tone="accent">client-visible</Tag>
            ) : (
              <Tag tone="outline">internal</Tag>
            )}
            {password.requireReasonToView && (
              <Tag tone="warn">reason required</Tag>
            )}
            {password.archivedAt && <Tag tone="default">archived</Tag>}
            {password.assetId && (
              <Tag tone="accent">
                embedded on
                <Link
                  href={`/admin/companies/${companyId}/assets/${password.assetId}`}
                  style={{
                    color: 'inherit',
                    textDecoration: 'underline',
                    marginLeft: 4,
                  }}
                >
                  asset
                </Link>
              </Tag>
            )}
          </span>
        }
        actions={
          <PasswordHeaderActions
            companyId={companyId}
            password={password}
            folders={folders}
            canManage={manage}
            generatorDefaults={settings.passwordGeneratorDefaults}
          />
        }
      />
      <PageBody>
        <PasswordDetailClient
          companyId={companyId}
          password={password}
          versions={versions}
          canManage={manage}
          canManageInternalAccess={manageInternalAccess}
          folderName={folder?.name ?? null}
          assetName={linkedAsset?.name ?? null}
          me={{ id: me.id, role: me.role }}
        />
      </PageBody>
    </>
  );
}
