'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { safeExternalHref } from '@weavestream/shared';
import type { PasswordDetail, PasswordVersionSummary } from '@weavestream/shared';
import { copyToClipboard } from '@weavestream/shared/browser';
import {
  FormattedCalendarDate,
  FormattedDate,
  FormattedDateTime,
} from '../../../../../../../lib/timezone-context';
import { Btn, Icon, Panel, ShowMore, Tag, useToast } from '../../../../../../../components/ui';
import { PasswordRevealField } from '../../../../../../../components/passwords/password-reveal-field';
import { TotpCode } from '../../../../../../../components/passwords/totp-code';
import { PasswordStrengthMeter } from '../../../../../../../components/passwords/password-strength-meter';
import { LinkedItemsPanel } from '../../../../../../../components/relations';
import { AttachmentsPanel } from '../../../../../../../components/upload/attachments-panel';
import { formatCredentialUrl } from './credential-url';
import { InternalAccessDialog, InternalAccessPanel } from './internal-access-panel';
import { VersionHistoryPanel } from './version-history-panel';

interface Props {
  companyId: string;
  password: PasswordDetail;
  versions: PasswordVersionSummary[];
  canManage: boolean;
  canManageInternalAccess: boolean;
  folderName: string | null;
  assetName: string | null;
  me: { id: string; role: string };
}

/**
 * Phase 10 — password detail client shell.
 *
 * Renders the read-only summary panels + a reveal field + live TOTP
 * code + sidebar metadata. Header actions live in PasswordHeaderActions,
 * which the page renders into the breadcrumb row rather than a second
 * header row of its own.
 */
export function PasswordDetailClient({
  companyId,
  password,
  versions,
  canManage,
  canManageInternalAccess,
  folderName,
  assetName,
  me,
}: Props) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [editingInternalAccess, setEditingInternalAccess] = useState(false);
  const [versionsExpanded, setVersionsExpanded] = useState(false);

  async function copyUsername() {
    if (!password.username) return;
    const ok = await copyToClipboard(password.username);
    toast.push(ok ? 'Username copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  async function copyUrl() {
    if (!password.url) return;
    const ok = await copyToClipboard(password.url);
    toast.push(ok ? 'URL copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  const displayUrl = useMemo(() => formatCredentialUrl(password.url), [password.url]);
  const safeUrl = useMemo(
    () => (password.url?.trim() ? safeExternalHref(password.url) : null),
    [password.url],
  );

  return (
    <>
      <div
        className="detail-grid-main-aside"
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Panel title="Credentials">
            {/*
              `minmax(0, 1fr)`, not `1fr`: a bare `1fr` track cannot shrink
              below its content's min-content, so the reveal row's buttons
              and the nowrap strength verdict pushed the column past a phone
              viewport. Each value cell also takes `minWidth: 0` so the
              grid item itself can shrink with the track. On phones
              `.password-field-grid` stacks each label above its value
              (`globals.css`).
            */}
            <div
              className="password-field-grid"
              style={{
                display: 'grid',
                gridTemplateColumns: '120px minmax(0, 1fr)',
                rowGap: 12,
                columnGap: 16,
                fontSize: 13,
              }}
            >
              <Label>Username</Label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  minWidth: 0,
                }}
              >
                <code
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 13,
                    color: 'var(--text)',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {password.username ?? '—'}
                </code>
                {password.username && (
                  <Btn
                    size="sm"
                    onClick={() => void copyUsername()}
                    title="Copy"
                    style={{ marginLeft: 'auto', flexShrink: 0 }}
                  >
                    <Icon.copy size={14} />
                  </Btn>
                )}
              </div>

              <Label>Password</Label>
              <div style={{ minWidth: 0 }}>
                <PasswordRevealField
                  companyId={companyId}
                  passwordId={password.id}
                  requiresReason={password.requireReasonToView}
                  // `updatedAt` rolls forward on every server-side
                  // mutation (edit, restore-from-version, etc). Using
                  // it as the reset key guarantees any cached plaintext
                  // in the client component is flushed after a restore
                  // so the next reveal fetches the newly-active value.
                  resetKey={password.updatedAt}
                />
              </div>

              <Label>Strength</Label>
              {/*
                The breach count sits with the strength meter because both
                answer the same question — is this secret safe to keep —
                and both must be readable without opening anything. Same
                wording and tone as the passwords table, so a row and its
                detail page agree.
              */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  flexWrap: 'wrap',
                  minWidth: 0,
                }}
              >
                <PasswordStrengthMeter
                  score={password.passwordStrength}
                  width={220}
                  inline
                  style={{ minWidth: 0 }}
                />
                {(password.pwnedCount ?? 0) > 0 && (
                  <Tag tone="danger">pwned ×{password.pwnedCount}</Tag>
                )}
              </div>

              {password.hasTotp && (
                <>
                  <Label>TOTP</Label>
                  <div style={{ minWidth: 0 }}>
                    <TotpCode
                      companyId={companyId}
                      passwordId={password.id}
                      resetKey={password.updatedAt}
                    />
                  </div>
                </>
              )}

              <Label>URL</Label>
              <div style={{ minWidth: 0 }}>
                {password.url?.trim() ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      minWidth: 0,
                    }}
                  >
                    {safeUrl ? (
                      <a
                        href={safeUrl}
                        target="_blank"
                        rel="noreferrer"
                        title={password.url}
                        style={{
                          color: 'var(--accent)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          flex: 1,
                        }}
                      >
                        {displayUrl}
                      </a>
                    ) : (
                      <span
                        title={password.url}
                        style={{
                          color: 'var(--text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                          flex: 1,
                        }}
                      >
                        {password.url}
                      </span>
                    )}
                    <Btn
                      size="sm"
                      onClick={() => void copyUrl()}
                      title="Copy URL"
                      style={{ marginLeft: 'auto', flexShrink: 0 }}
                    >
                      <Icon.copy size={14} />
                    </Btn>
                  </div>
                ) : (
                  <span style={{ color: 'var(--muted)' }}>—</span>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="Notes">
            {password.notes ? (
              <div
                style={{
                  fontSize: 13,
                  color: 'var(--text)',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.5,
                }}
              >
                {password.notes}
              </div>
            ) : (
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>No notes.</div>
            )}
          </Panel>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <LinkedItemsPanel
            companyId={companyId}
            entityType="password"
            entityId={password.id}
            editable={canManage && !password.archivedAt}
          />

          <AttachmentsPanel
            companyId={companyId}
            entityType="password"
            entityId={password.id}
            editable={canManage && !password.archivedAt}
          />

          {/*
            Details, internal access, and version history are system
            metadata, not the credential itself — the same class the
            asset and subnet pages already put behind a disclosure.
            Credentials, notes, linked items, and attachments stay
            outside it, per the ShowMore contract.
          */}
          <ShowMore>
            <Panel title="Details">
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: '100px 1fr',
                  rowGap: 8,
                  columnGap: 10,
                  fontSize: 12.5,
                  margin: 0,
                }}
              >
                {password.assetId && (
                  <>
                    <dt style={dt}>Asset</dt>
                    <dd style={dd}>
                      <Link
                        href={`/admin/companies/${companyId}/assets/${password.assetId}`}
                        style={{ color: 'var(--accent)' }}
                      >
                        {assetName ?? 'View asset'}
                      </Link>
                    </dd>
                  </>
                )}
                <dt style={dt}>Folder</dt>
                <dd style={dd}>{folderName ?? 'Unfiled'}</dd>
                {password.tags.length > 0 && (
                  <>
                    <dt style={dt}>Tags</dt>
                    <dd style={dd}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {password.tags.map((t) => (
                          <Tag key={t} tone="outline">
                            {t}
                          </Tag>
                        ))}
                      </div>
                    </dd>
                  </>
                )}
                {password.lastRotatedAt && (
                  <>
                    <dt style={dt}>Last rotated</dt>
                    <dd style={dd}>
                      <FormattedDate value={password.lastRotatedAt} />
                    </dd>
                  </>
                )}
                {password.expiresAt && (
                  <>
                    <dt style={dt}>Expires</dt>
                    <dd style={dd}>
                      <FormattedCalendarDate value={password.expiresAt} />
                    </dd>
                  </>
                )}
                {password.rotationReminderDays != null && (
                  <>
                    <dt style={dt}>Rotation reminder</dt>
                    <dd style={dd}>{password.rotationReminderDays} days</dd>
                  </>
                )}
                <dt style={dt}>Created</dt>
                <dd style={dd}>
                  <FormattedDateTime value={password.createdAt} />
                </dd>
                <dt style={dt}>Updated</dt>
                <dd style={dd}>
                  <FormattedDateTime value={password.updatedAt} />
                </dd>
              </dl>
            </Panel>

            <InternalAccessPanel
              password={password}
              canManage={canManageInternalAccess && !password.archivedAt}
              currentUserId={me.id}
              onEdit={() => setEditingInternalAccess(true)}
            />

            <VersionHistoryPanel
              companyId={companyId}
              passwordId={password.id}
              versions={versions}
              canManage={canManage}
              requiresReason={password.requireReasonToView}
              expanded={versionsExpanded}
              onToggleExpanded={() => setVersionsExpanded((v) => !v)}
            />
          </ShowMore>
        </div>
      </div>

      {editingInternalAccess && (
        <InternalAccessDialog
          companyId={companyId}
          password={password}
          onClose={() => setEditingInternalAccess(false)}
          onSaved={() => {
            setEditingInternalAccess(false);
            toast.push('Internal access updated', 'ok');
            startTransition(() => router.refresh());
          }}
        />
      )}
    </>
  );
}

const dt = {
  color: 'var(--muted)',
  fontFamily: 'var(--font-mono)',
  textTransform: 'uppercase' as const,
  letterSpacing: 0.3,
  fontSize: 11,
};
const dd = { margin: 0, color: 'var(--text)' };

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="password-field-label"
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
