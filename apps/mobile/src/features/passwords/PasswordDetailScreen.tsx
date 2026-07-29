import { useRef, useState } from 'react';
import { copyToClipboard } from '@weavestream/shared/browser';
import { formatDate, formatShortDateTime } from '@weavestream/shared';
import { ConfirmSheet } from '../../components/ConfirmSheet';
import { DetailHeader } from '../../components/DetailHeader';
import { DeepLinkNotFound } from '../../components/DeepLinkNotFound';
import { MetaRow } from '../../components/MetaRow';
import { ShowMore } from '../../components/ShowMore';
import { Icon } from '../../components/Icon';
import {
  Button,
  Card,
  IconButton,
  Screen,
  Title,
} from '../../components/primitives';
import {
  ErrorBanner,
  OfflineBanner,
  SkeletonList,
} from '../../components/states';
import { useToast } from '../../components/Toast';
import { ApiError, isRestrictedError } from '../../lib/api';
import { useOnline } from '../../lib/use-online';
import { useOrgScope } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useCompanyAccess } from '../../lib/use-company-access';
import { deviceTimeZone } from '../../lib/timezone';
import { RelatedSection } from '../relations/RelatedSection';
import { useRelations } from '../relations/queries';
import { notesToPlaintext } from './api';
import { attentionTier } from './attention';
import { recallListFilter } from './list-filter-memory';
import {
  NotesCard,
  PasswordValueRow,
  TotpRow,
  UrlRow,
  UsernameRow,
} from './credential-rows';
import {
  useArchivePassword,
  usePasswordDetail,
  usePasswordFolders,
  useRestorePassword,
} from './queries';
import { RevealReasonSheet } from './RevealReasonSheet';
import { StrengthMeter } from './StrengthMeter';
import { useReveal } from './use-reveal';
import { useTotpCode } from './use-totp';

/**
 * Password detail — 1c's content inside 2b's shell (tab bar intact).
 * The T1 budget and nothing else above the fold: title, strength row,
 * credential rows, Related. Everything T2 sits behind ShowMore, whose
 * collapsed label carries the attention dot so a hidden expiry is
 * never silently buried. Version history, color, and archived-list
 * management are desktop work.
 */
export function PasswordDetailScreen({ passwordId }: { passwordId: string }) {
  const { currentOrg } = useOrgScope();
  const online = useOnline();
  const navigate = useScopedNavigate();
  const toast = useToast();
  const { canWrite, isClientUser } = useCompanyAccess();
  // See use-company-access: CLIENT_USER write UI is withheld even on a
  // FULL membership.
  const canManage = canWrite && !isClientUser;

  const orgId = currentOrg?.id ?? null;
  const detailQuery = usePasswordDetail(orgId, passwordId);
  const relationsQuery = useRelations(orgId, 'password', passwordId);
  const foldersQuery = usePasswordFolders(orgId);
  const archiveMutation = useArchivePassword(orgId);
  const restoreMutation = useRestorePassword(orgId);

  const detail = detailQuery.data;
  const archived = Boolean(detail?.archivedAt);

  const reveal = useReveal({
    companyId: orgId,
    passwordId,
    requireReason: detail?.requireReasonToView ?? false,
    resetKey: detail?.updatedAt ?? '',
  });

  const totp = useTotpCode({
    companyId: orgId,
    passwordId,
    enabled: Boolean(detail?.hasTotp) && !archived,
  });

  // Idempotence guard for archive. A ref, not `isPending`: mutation
  // status propagates to React on a microtask, so two taps in the same
  // frame would BOTH read a stale `isPending: false` — and the server
  // 400s the second archive, flashing a failure toast right after the
  // success one. The ref flips synchronously in the tap handler.
  const archiveInFlight = useRef(false);
  // Archive confirms via a sheet (Phase 4); restore stays immediate —
  // it is the undo, and confirming the undo would punish recovery.
  const [confirmingArchive, setConfirmingArchive] = useState(false);
  function onArchive() {
    if (archiveInFlight.current) return;
    archiveInFlight.current = true;
    archiveMutation.mutate(passwordId, {
      onSuccess: () => {
        setConfirmingArchive(false);
        toast.push('Password archived', 'ok');
      },
      // Sheet stays open on failure so retry is one tap.
      onError: () => toast.push('Couldn’t archive password.', 'danger'),
      onSettled: () => {
        archiveInFlight.current = false;
      },
    });
  }

  function onRestore() {
    restoreMutation.mutate(passwordId, {
      onSuccess: () => toast.push('Password restored', 'ok'),
      onError: () => toast.push('Couldn’t restore password.', 'danger'),
    });
  }

  function copyPlain(value: string, doneMessage: string) {
    void copyToClipboard(value).then((ok) =>
      ok
        ? toast.push(doneMessage, 'ok')
        : toast.push('Clipboard unavailable.', 'danger'),
    );
  }

  const error = detailQuery.error;
  const notFound = error instanceof ApiError && error.status === 404;
  const restricted = isRestrictedError(error);

  const tz = deviceTimeZone();
  const now = Date.now();
  const notesText = detail ? notesToPlaintext(detail.notes) : '';
  const folderName =
    detail?.folderId != null
      ? (foldersQuery.data?.find((f) => f.id === detail.folderId)?.name ?? '—')
      : '—';
  const expiryTone: 'danger' | 'warn' | undefined = detail?.expiresAt
    ? Date.parse(detail.expiresAt) <= now
      ? 'danger'
      : attentionTier(detail, now) === 'warn'
        ? 'warn'
        : undefined
    : undefined;

  return (
    <>
      <DetailHeader
        backLabel="Passwords"
        backTo="/passwords"
        backSearch={recallListFilter(orgId)}
        actions={
          detail && !archived && canManage ? (
            <>
              <IconButton
                icon="edit"
                label="Edit password"
                // `upIsBack`: this detail is one entry behind, so the
                // form's Cancel may pop history back to it.
                onClick={() =>
                  navigate({ to: `/passwords/${passwordId}/edit`, upIsBack: true })
                }
              />
              {/* Opens the confirm sheet (Phase 4 — was one-tap
                  "desktop parity" until desktop passwords gained the
                  same confirmation). */}
              <IconButton
                icon="archive"
                label="Archive password"
                onClick={() => setConfirmingArchive(true)}
                disabled={archiveMutation.isPending}
              />
            </>
          ) : undefined
        }
      />

      <Screen>
        {!online && <OfflineBanner />}

        {detailQuery.isPending && <SkeletonList rows={4} />}

        {!detailQuery.isPending && notFound && (
          <DeepLinkNotFound message="This password wasn’t found. It may have been removed, or you may not have access to it." />
        )}

        {!detailQuery.isPending && restricted && (
          <ErrorBanner title="You don’t have access to this credential." />
        )}

        {!detailQuery.isPending && error && !notFound && !restricted && (
          <ErrorBanner
            title="Couldn’t load this password."
            detail="Check your connection and try again."
            onRetry={() => void detailQuery.refetch()}
          />
        )}

        {detail && (
          <>
            <div className="flex flex-col gap-2.25">
              <Title className="leading-[1.15]">{detail.name}</Title>

              {(detail.passwordStrength !== null ||
                (detail.pwnedCount ?? 0) > 0) && (
                <div className="flex flex-wrap items-center gap-2.5">
                  <StrengthMeter score={detail.passwordStrength} />
                  {(detail.pwnedCount ?? 0) > 0 && (
                    <span className="rounded-[7px] bg-danger-soft px-2.25 py-1 text-[13px] font-medium text-danger">
                      pwned ×{detail.pwnedCount}
                    </span>
                  )}
                </div>
              )}
            </div>

            {archived && (
              <Card className="flex flex-col gap-3 border-0 bg-warn-soft px-4 py-3.5">
                <span className="flex items-center gap-2 text-body font-medium text-text">
                  <Icon name="archive" size={20} className="text-muted" />
                  This password is archived.
                </span>
                {canManage && (
                  <Button
                    kind="primary"
                    onClick={onRestore}
                    disabled={restoreMutation.isPending}
                  >
                    {restoreMutation.isPending ? 'Restoring…' : 'Restore'}
                  </Button>
                )}
              </Card>
            )}

            {!archived && (
              <div className="flex flex-col gap-2.5">
                {detail.username?.trim() && (
                  <UsernameRow
                    username={detail.username}
                    onCopy={() => copyPlain(detail.username!, 'Username copied')}
                  />
                )}

                <PasswordValueRow
                  plaintext={reveal.plaintext}
                  remainingS={reveal.remainingS}
                  busy={reveal.busy}
                  onToggle={reveal.toggleReveal}
                  onCopy={reveal.copyTap}
                  onHideNow={reveal.hideNow}
                />

                {detail.hasTotp && (
                  <TotpRow
                    code={totp.code}
                    remainingS={totp.remainingS}
                    progress={totp.progress}
                    failed={totp.failed}
                    onCopy={(code) => copyPlain(code, 'One-time code copied')}
                  />
                )}

                {detail.url?.trim() && (
                  <UrlRow
                    url={detail.url}
                    onCopy={() => copyPlain(detail.url!, 'URL copied')}
                  />
                )}

                {notesText && <NotesCard text={notesText} />}
              </div>
            )}

            {relationsQuery.data && <RelatedSection groups={relationsQuery.data} />}

            <ShowMore dot={attentionTier(detail, now)}>
              <Card className="flex flex-col divide-y divide-line px-4">
                <MetaRow label="Folder" value={folderName} />
                <MetaRow
                  label="Tags"
                  value={detail.tags.length > 0 ? detail.tags.join(', ') : '—'}
                />
                <MetaRow
                  label="Visible to clients"
                  value={detail.visibleToClients ? 'Yes' : 'No'}
                />
                <MetaRow
                  label="Rotation reminder"
                  value={
                    detail.rotationReminderDays
                      ? `Every ${detail.rotationReminderDays} days`
                      : '—'
                  }
                />
                <MetaRow
                  label="Last rotated"
                  value={
                    detail.lastRotatedAt ? formatDate(detail.lastRotatedAt, tz) : '—'
                  }
                />
                <MetaRow
                  label="Expires"
                  value={detail.expiresAt ? formatDate(detail.expiresAt, tz) : '—'}
                  tone={expiryTone}
                />
                {/* Timestamps only — resolving author names would need
                    another endpoint; laptop work. */}
                <MetaRow
                  label="Created"
                  value={formatShortDateTime(detail.createdAt, tz)}
                />
                <MetaRow
                  label="Updated"
                  value={formatShortDateTime(detail.updatedAt, tz)}
                />
              </Card>
            </ShowMore>
          </>
        )}
      </Screen>

      <RevealReasonSheet
        open={reveal.sheet !== null}
        action={reveal.sheet?.action ?? 'view'}
        busy={reveal.sheet?.busy ?? false}
        error={reveal.sheet?.error ?? null}
        onSubmit={reveal.submitReason}
        onClose={reveal.closeSheet}
      />

      <ConfirmSheet
        open={confirmingArchive}
        title="Archive password?"
        confirmLabel="Archive"
        busy={archiveMutation.isPending}
        onConfirm={onArchive}
        onClose={() => setConfirmingArchive(false)}
      >
        <span className="font-semibold text-text">{detail?.name}</span> will be
        hidden from the default list. The credential and its links are
        preserved and can be restored at any time.
      </ConfirmSheet>
    </>
  );
}
