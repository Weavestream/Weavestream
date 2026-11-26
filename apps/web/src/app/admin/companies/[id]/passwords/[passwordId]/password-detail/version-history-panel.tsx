'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { problemMessage } from '@weavestream/shared';
import type { PasswordRestoreField, PasswordVersionSummary } from '@weavestream/shared';
import { copyToClipboard } from '@weavestream/shared/browser';
import { apiFetch } from '../../../../../../../lib/api';
import { FormattedShortDateTime } from '../../../../../../../lib/timezone-context';
import { Btn, Icon, Panel, useToast } from '../../../../../../../components/ui';
import { sortVersionsNewestFirst, visibleVersions } from './version-history-order';

export function VersionHistoryPanel({
  companyId,
  passwordId,
  versions,
  current,
  canManage,
  requiresReason,
  expanded,
  onToggleExpanded,
}: {
  companyId: string;
  passwordId: string;
  versions: PasswordVersionSummary[];
  /** The password's live values, so a field restore that would change nothing is not offered. */
  current: CurrentValues;
  canManage: boolean;
  requiresReason: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const [, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);

  async function restore(version: number, fields?: PasswordRestoreField[]) {
    const label = fields && fields.length === 1 ? RESTORABLE_LABEL[fields[0] as RestorableField] : null;
    const message = label
      ? `Restore the ${label} from version #${version} as a new version on top of history?\n\nOnly the ${label} changes; every other field keeps its current value. This is forward-only — a new version will be appended, the current version is kept in history.`
      : `Restore version #${version} as a new version on top of history?\n\nThis is forward-only — a new version will be appended, the current version is kept in history.`;
    if (!window.confirm(message)) return;
    setBusy(version);
    let res: Awaited<ReturnType<typeof apiFetch>>;
    try {
      res = await apiFetch(
        `/companies/${companyId}/passwords/${passwordId}/versions/${version}/restore`,
        fields
          ? { method: 'POST', body: JSON.stringify({ fields }) }
          : { method: 'POST' },
      );
    } catch {
      // apiFetch re-throws network failures; report them and re-enable the buttons.
      toast.push('Restore failed', 'danger');
      return;
    } finally {
      setBusy(null);
    }
    if (!res.ok) {
      toast.push(
        problemMessage(res.problem) ?? 'Restore failed',
        'danger',
      );
      return;
    }
    toast.push(
      label ? `Restored ${label} from v${version}` : `Restored from v${version}`,
      'ok',
    );
    startTransition(() => router.refresh());
  }

  const sorted = useMemo(() => sortVersionsNewestFirst(versions), [versions]);
  const visible = visibleVersions(sorted, expanded);

  return (
    <Panel
      title="Version history"
      actions={
        sorted.length > 1 ? (
          <button
            type="button"
            onClick={onToggleExpanded}
            style={{
              border: 0,
              background: 'transparent',
              color: 'var(--accent)',
              fontSize: 11,
              cursor: 'pointer',
              padding: 0,
              whiteSpace: 'nowrap',
            }}
          >
            {expanded ? 'Show latest' : 'View full history'}
          </button>
        ) : null
      }
    >
      {sorted.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>No versions yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visible.map((version) => (
            <VersionHistoryItem
              key={version.version}
              companyId={companyId}
              passwordId={passwordId}
              version={version}
              current={current}
              isLatest={version.version === sorted[0]?.version}
              canManage={canManage}
              requiresReason={requiresReason}
              busy={busy === version.version}
              onRestore={(fields) => void restore(version.version, fields)}
            />
          ))}
        </div>
      )}
    </Panel>
  );
}

function VersionHistoryItem({
  companyId,
  passwordId,
  version,
  current,
  isLatest,
  canManage,
  requiresReason,
  busy,
  onRestore,
}: {
  companyId: string;
  passwordId: string;
  version: PasswordVersionSummary;
  current: CurrentValues;
  /** The newest version is the live state, so restoring it changes nothing. */
  isLatest: boolean;
  canManage: boolean;
  requiresReason: boolean;
  busy: boolean;
  onRestore: (fields?: PasswordRestoreField[]) => void;
}) {
  const toast = useToast();
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [revealBusy, setRevealBusy] = useState(false);

  useEffect(() => {
    if (!plaintext) return;
    const timer = window.setTimeout(() => setPlaintext(null), 30_000);
    return () => window.clearTimeout(timer);
  }, [plaintext]);

  async function revealVersionPassword() {
    let reason: string | undefined;
    if (requiresReason) {
      const entered = window.prompt('Reason for revealing this historical password');
      if (entered === null) return;
      reason = entered.trim();
      if (!reason) {
        toast.push('A reason is required.', 'danger');
        return;
      }
    }
    setRevealBusy(true);
    const res = await apiFetch<{ password: string }>(
      `/companies/${companyId}/passwords/${passwordId}/versions/${version.version}/reveal`,
      { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
    );
    setRevealBusy(false);
    if (!res.ok || !res.data) {
      toast.push(problemMessage(res.problem) ?? 'Reveal failed', 'danger');
      return;
    }
    setPlaintext(res.data.password);
  }

  async function copyVersionPassword() {
    if (!plaintext) return;
    const ok = await copyToClipboard(plaintext);
    toast.push(ok ? 'Historical password copied' : 'Clipboard unavailable', ok ? 'ok' : 'danger');
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
            minWidth: 0,
          }}
        >
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--text)',
              fontWeight: 600,
            }}
          >
            v{version.version}
          </span>
          {/*
            No name, no author line. The old fallback printed
            `changedBy` — a raw user id — whenever the name would not
            resolve, which is a defensive branch: the app never
            hard-deletes a user, and the lookup does not filter
            deactivated ones. An id on screen tells the reader nothing
            and reads like a name. The version number and timestamp
            carry the row on their own.
          */}
          {version.changedByName && (
            <span
              title={version.changedByName}
              style={{
                fontSize: 12,
                color: 'var(--muted)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {version.changedByName}
            </span>
          )}
        </div>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            color: 'var(--dim)',
            whiteSpace: 'nowrap',
          }}
        >
          <FormattedShortDateTime value={version.createdAt} />
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div
          title={version.changeReason ?? undefined}
          style={{
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 11.5,
            color: 'var(--muted)',
          }}
        >
          {version.changedFields.length > 0 ? version.changedFields.join(', ') : 'metadata'}
          {version.changeReason ? ` · ${version.changeReason}` : ''}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          <TextAction
            disabled={revealBusy}
            onClick={() => (plaintext ? setPlaintext(null) : void revealVersionPassword())}
          >
            {plaintext ? 'Hide' : revealBusy ? 'Revealing...' : 'Reveal'}
          </TextAction>
          {canManage && !isLatest && (
            <TextAction disabled={busy} onClick={() => onRestore()}>
              Restore
            </TextAction>
          )}
        </div>
      </div>
      <CapturedFields
        version={version}
        current={current}
        canManage={canManage}
        busy={busy}
        onRestoreField={(field) => onRestore([field])}
      />
      {plaintext && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            minWidth: 0,
            padding: '5px 7px',
            borderRadius: 6,
            background: 'var(--elev)',
            border: '1px solid var(--line)',
          }}
        >
          <code
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontSize: 12,
              color: 'var(--text)',
            }}
          >
            {plaintext}
          </code>
          <Btn
            size="sm"
            onClick={() => void copyVersionPassword()}
            title="Copy historical password"
          >
            <Icon.copy size={14} />
          </Btn>
        </div>
      )}
    </div>
  );
}

type RestorableField = 'name' | 'username' | 'url';

const RESTORABLE_LABEL: Record<RestorableField, string> = {
  name: 'name',
  username: 'username',
  url: 'URL',
};
const RESTORABLE_FIELDS: readonly RestorableField[] = ['name', 'username', 'url'];

type CurrentValues = { name: string; username: string | null; url: string | null };

/**
 * The plain-text values this version captured (name, username, URL).
 * Fields listed in `changedFields` are highlighted — with a "changed" tag,
 * not colour alone. Notes, password and TOTP are never shown here: they are
 * encrypted and only leave through reveal. Older API payloads carry no
 * values, in which case nothing renders.
 */
function CapturedFields({
  version,
  current,
  canManage,
  busy,
  onRestoreField,
}: {
  version: PasswordVersionSummary;
  current: CurrentValues;
  canManage: boolean;
  busy: boolean;
  onRestoreField: (field: RestorableField) => void;
}) {
  const rows = RESTORABLE_FIELDS.filter((f) => version[f] !== undefined);
  if (rows.length === 0) return null;
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}
      aria-label={`Values captured in version ${version.version}`}
    >
      {rows.map((field) => {
        const value = version[field];
        // Version 1 lists every field as changed; it is the baseline, not a change.
        const changed = version.version > 1 && version.changedFields.includes(field);
        // Empty and null are the same stored value; only offer a restore that changes something.
        const differsFromCurrent = (value || null) !== (current[field] || null);
        return (
          <div
            key={field}
            data-changed={changed ? 'true' : 'false'}
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'baseline',
              columnGap: 8,
              rowGap: 2,
              minWidth: 0,
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 11.5,
              background: changed ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <span style={{ color: 'var(--muted)' }}>{RESTORABLE_LABEL[field]}:</span>
            {/* One line per value: a long URL repeated in every version would
                otherwise fill the narrow side column. Hover shows it in full. */}
            <span
              title={value || undefined}
              style={{
                minWidth: 0,
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: 'var(--text)',
                fontWeight: changed ? 600 : 400,
                fontFamily: field === 'name' ? undefined : 'var(--font-mono)',
              }}
            >
              {value ? value : <em style={{ color: 'var(--dim)' }}>(empty)</em>}
            </span>
            {changed && (
              <span style={{ fontSize: 10.5, color: 'var(--accent)' }}>changed</span>
            )}
            {canManage && differsFromCurrent && (
              <TextAction disabled={busy} onClick={() => onRestoreField(field)}>
                {`Restore this ${RESTORABLE_LABEL[field]}`}
              </TextAction>
            )}
          </div>
        );
      })}
    </div>
  );
}

function TextAction({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        border: 0,
        background: 'transparent',
        padding: 0,
        color: disabled ? 'var(--muted)' : 'var(--accent)',
        fontSize: 11.5,
        cursor: disabled ? 'default' : 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}
