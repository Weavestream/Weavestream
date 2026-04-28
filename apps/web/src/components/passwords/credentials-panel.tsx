import Link from 'next/link';
import {
  getSettings,
  listPasswordFolders,
  listPasswords,
  type PasswordFolderRow,
  type PasswordSummary,
} from '../../lib/server-api';
import { Icon, Panel, Tag } from '../ui';
import { AttachCredentialButton } from './attach-credential-button';
import { PasswordInlineActions } from './password-inline-actions';

/**
 * Server component. Rendered in the asset detail aside below the
 * attachments panel. Lists every Password row that's linked to this
 * asset (i.e. `assetId === assetId`), including archived rows — the
 * archive cascade sets `archivedAt` on linked credentials, so a
 * restored asset shows them again.
 *
 * Rows surface compact reveal + copy buttons (admin mode only) so
 * staff can grab a credential without leaving the asset. The heavy
 * flows (edit/archive/TOTP) still live on the dedicated detail page.
 */
export async function CredentialsPanel({
  companyId,
  assetId,
  mode = 'admin',
  companySlug,
}: {
  companyId: string;
  assetId: string;
  mode?: 'admin' | 'portal';
  companySlug?: string;
}) {
  const [items, folders, settings] = await Promise.all([
    listPasswords(companyId, { assetId }),
    mode === 'admin'
      ? listPasswordFolders(companyId)
      : Promise.resolve<PasswordFolderRow[]>([]),
    getSettings(),
  ]);
  const generatorDefaults = settings.passwordGeneratorDefaults;
  const activeCount = items.filter((p) => !p.archivedAt).length;
  const base =
    mode === 'admin'
      ? `/admin/companies/${companyId}/passwords`
      : `/portal/${companySlug}/passwords`;

  return (
    <Panel
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon.lock size={14} /> Credentials
          {activeCount > 0 && (
            <Tag tone="outline" style={{ marginLeft: 6 }}>
              {activeCount}
            </Tag>
          )}
        </span>
      }
      actions={
        mode === 'admin' ? (
          <AttachCredentialButton
            companyId={companyId}
            assetId={assetId}
            folders={folders}
            generatorDefaults={generatorDefaults}
            label="Add"
            variant="button"
          />
        ) : null
      }
      noPad
    >
      {items.length === 0 ? (
        <div
          style={{
            padding: '16px 14px',
            fontSize: 13,
            color: 'var(--muted)',
          }}
        >
          {mode === 'admin'
            ? 'No credentials are attached to this asset yet.'
            : 'No credentials are available for this asset.'}
          {mode === 'admin' && (
            <div style={{ marginTop: 8 }}>
              <AttachCredentialButton
                companyId={companyId}
                assetId={assetId}
                folders={folders}
                generatorDefaults={generatorDefaults}
                label="+ Attach a credential"
              />
            </div>
          )}
        </div>
      ) : (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: 0,
          }}
        >
          {items.map((p) => (
            <li
              key={p.id}
              style={{
                padding: '10px 14px',
                borderTop: '1px solid var(--border)',
                opacity: p.archivedAt ? 0.55 : 1,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  minWidth: 0,
                }}
              >
                <Link
                  href={`${base}/${p.id}`}
                  style={{
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    textDecoration: 'none',
                    color: 'inherit',
                    flex: 1,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.name}
                  </span>
                  {p.username && (
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--muted)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p.username}
                    </span>
                  )}
                </Link>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {p.hasTotp && (
                    <Tag tone="outline" style={{ fontSize: 10 }}>
                      TOTP
                    </Tag>
                  )}
                  {p.archivedAt && (
                    <Tag tone="default" style={{ fontSize: 10 }}>
                      archived
                    </Tag>
                  )}
                </div>
              </div>
              {!p.archivedAt && (
                <InlineRowActions
                  companyId={companyId}
                  password={p}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * Small server-rendered wrapper that only mounts the client reveal
 * component for unarchived rows. Keeping it here (rather than in the
 * client file) lets us pass the server-fetched summary row straight
 * through without re-shaping types on the client.
 */
function InlineRowActions({
  companyId,
  password,
}: {
  companyId: string;
  password: PasswordSummary;
}) {
  return (
    <PasswordInlineActions
      companyId={companyId}
      passwordId={password.id}
      requiresReason={password.requireReasonToView}
      hasTotp={password.hasTotp}
      username={password.username}
      url={password.url}
      showLinkCopy
      showUsernameCopy
      showTotpCopy
    />
  );
}
