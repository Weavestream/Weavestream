import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getMe,
  listPasswordFolders,
  listPasswords,
  serverApiFetch,
  type CompanyDetail,
} from '../../../../../lib/server-api';
import { canManage } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { Panel, Tag } from '../../../../../components/ui';
import { companyCrumbs } from '../../../../../lib/company-crumbs';
import { buildTerm, lower } from '../../../../../lib/term';
import { getSettings } from '../../../../../lib/server-api';
import { PasswordsBrowser } from './passwords-browser';

export const metadata: Metadata = { title: 'Passwords' };

/**
 * Phase 10 — Admin passwords vault list.
 *
 * Loads the flat password list + folder tree + list of assets in this
 * company (for the embedded-credential picker). No secrets cross the
 * server boundary here — list rows never carry ciphertext.
 */
export default async function CompanyPasswordsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: companyId } = await params;
  const sp = await searchParams;
  const me = (await getMe())!;
  const settings = await getSettings();
  const term = buildTerm(settings);

  const companyRes = await serverApiFetch<CompanyDetail>(
    `/companies/${companyId}`,
  );
  if (!companyRes.ok || !companyRes.data) notFound();
  const company = companyRes.data;

  const archived = sp.archived === '1';
  const [items, folders] = await Promise.all([
    listPasswords(companyId, { archived }),
    listPasswordFolders(companyId),
  ]);

  const manage = canManage(me.role);
  const prefillAssetId = typeof sp.assetId === 'string' ? sp.assetId : undefined;
  const openNew = sp.new === '1';

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Passwords' })}
        title="Passwords"
        description={`Encrypted credential vault for this ${lower(
          term.one,
        )}. Passwords are stored AES-256-GCM at rest; reveals are audit-logged.`}
      />
      <PageBody>
        <Panel
          title={
            <span>
              {items.filter((p) => !p.archivedAt).length} active credential
              {items.filter((p) => !p.archivedAt).length === 1 ? '' : 's'}
              {archived && (
                <Tag tone="outline" style={{ marginLeft: 10 }}>
                  incl. archived
                </Tag>
              )}
            </span>
          }
          noPad
        >
          <PasswordsBrowser
            companyId={companyId}
            rows={items}
            folders={folders}
            canManage={manage}
            openNew={openNew}
            prefillAssetId={prefillAssetId}
            generatorDefaults={settings.passwordGeneratorDefaults}
          />
        </Panel>
      </PageBody>
    </>
  );
}
