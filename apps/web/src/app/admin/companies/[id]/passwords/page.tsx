import type { Metadata } from 'next';
import {
  getCompanyActivePasswords,
  getCompanyDetail,
  getCompanyPasswordFolders,
  getMe,
  listPasswords,
  throwUnlessFound,
} from '../../../../../lib/server-api';
import { canWriteCompany } from '../../../../../lib/roles';
import { PageBody, PageHeader } from '../../../../../components/shell/page-header';
import { LayoutSwatch, Panel, Tag } from '../../../../../components/ui';
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

  const companyRes = await getCompanyDetail(companyId);
  const company = throwUnlessFound(companyRes, `/companies/${companyId}`);

  const archived = sp.archived === '1';
  // When showing the default "active" view, reuse the cached list the
  // layout already fetched. Falling back to `listPasswords` when the
  // user toggles "include archived" keeps the archived-only query
  // path untouched — that read is always fresh and not layout-shared.
  const [items, folders] = await Promise.all([
    archived
      ? listPasswords(companyId, { archived: true })
      : getCompanyActivePasswords(companyId),
    getCompanyPasswordFolders(companyId),
  ]);

  const manage = canWriteCompany(me, company.id);
  const prefillAssetId = typeof sp.assetId === 'string' ? sp.assetId : undefined;
  const openNew = sp.new === '1';

  return (
    <>
      <PageHeader
        crumbs={companyCrumbs(term, company, { label: 'Passwords' })}
        leading={<LayoutSwatch icon="lock" color="var(--accent)" size={48} />}
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
