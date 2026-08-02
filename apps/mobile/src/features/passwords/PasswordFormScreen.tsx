import { useEffect, useState } from 'react';
import { optionalHttpUrlError, type PasswordDetail } from '@weavestream/shared';
import { FieldBlock, FieldError, Hint } from '../../components/FieldBlock';
import { FormScreenChrome } from '../../components/FormScreenChrome';
import { Icon } from '../../components/Icon';
import { Card, Input } from '../../components/primitives';
import { ErrorBanner, SkeletonList } from '../../components/states';
import { useToast } from '../../components/Toast';
import { ApiError } from '../../lib/api';
import { useBackOr } from '../../lib/use-back';
import { useOrgScope, type Org } from '../../lib/org-scope';
import { useScopedNavigate } from '../../lib/scoped-nav';
import { useCompanyAccess } from '../../lib/use-company-access';
import {
  buildCreatePayload,
  buildUpdatePayload,
  validateTotpSecret,
  notesToPlaintext,
  type PasswordFormValues,
  type TotpFormState,
} from './api';
import { GeneratorSheet } from './GeneratorSheet';
import { recallListFilter } from './list-filter-memory';
import { useCreatePassword, usePasswordDetail, useUpdatePassword } from './queries';

/**
 * Create / edit form — a full-viewport routed page (the Shell hides
 * the tab bar for these paths). Fields per the Phase 2a decision:
 * Name, Username, Password (+ generator), URL, Notes, TOTP secret.
 * No folder, no tags, no client-visibility flags — desktop work; the
 * server's secure defaults (visibleToClients=false) apply.
 */
export function PasswordFormScreen(
  props: { mode: 'create' } | { mode: 'edit'; passwordId: string },
) {
  const { currentOrg, scopeStatus } = useOrgScope();
  const { canWrite, isClientUser } = useCompanyAccess();
  const canManage = canWrite && !isClientUser;
  const navigate = useScopedNavigate();

  const isEdit = props.mode === 'edit';
  const passwordId = isEdit ? props.passwordId : '';
  const orgId = currentOrg?.id ?? null;
  const detailQuery = usePasswordDetail(isEdit ? orgId : null, passwordId);

  // Deep-linked or role-changed viewers without write access bounce
  // straight back to the list — the server would 403 the save anyway;
  // this just avoids offering a dead form.
  useEffect(() => {
    if (scopeStatus === 'ready' && !canManage) {
      navigate({ to: '/passwords', replace: true });
    }
  }, [scopeStatus, canManage, navigate]);

  const cancelCreate = useBackOr('/passwords', recallListFilter(orgId));
  const cancelEdit = useBackOr(isEdit ? `/passwords/${passwordId}` : '/passwords');

  if (scopeStatus !== 'ready' || !currentOrg || !canManage) {
    return (
      <FormScreenChrome
        title={isEdit ? 'Edit password' : 'New password'}
        onCancel={cancelCreate}
        saveDisabled
        onSave={() => {}}
      >
        <SkeletonList rows={4} variant="row" />
      </FormScreenChrome>
    );
  }

  if (isEdit) {
    if (detailQuery.isPending) {
      return (
        <FormScreenChrome
          title="Edit password"
          onCancel={cancelEdit}
          saveDisabled
          onSave={() => {}}
        >
          <SkeletonList rows={4} variant="row" />
        </FormScreenChrome>
      );
    }
    if (detailQuery.error || !detailQuery.data) {
      return (
        <FormScreenChrome
          title="Edit password"
          onCancel={cancelEdit}
          saveDisabled
          onSave={() => {}}
        >
          <ErrorBanner
            title="Couldn’t load this password."
            detail="Check your connection and try again."
            onRetry={() => void detailQuery.refetch()}
          />
        </FormScreenChrome>
      );
    }
    return (
      <PasswordFormFields
        key={detailQuery.data.id}
        org={currentOrg}
        original={detailQuery.data}
        onCancel={cancelEdit}
      />
    );
  }

  return <PasswordFormFields org={currentOrg} original={null} onCancel={cancelCreate} />;
}

function PasswordFormFields({
  org,
  original,
  onCancel,
}: {
  org: Org;
  /** null = create. */
  original: PasswordDetail | null;
  onCancel: () => void;
}) {
  const toast = useToast();
  const navigate = useScopedNavigate();
  const isEdit = original !== null;
  const hadTotp = original?.hasTotp ?? false;

  const [name, setName] = useState(original?.name ?? '');
  const [username, setUsername] = useState(original?.username ?? '');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [url, setUrl] = useState(original?.url ?? '');
  const [notes, setNotes] = useState(notesToPlaintext(original?.notes));
  // TOTP: with an existing config the choice is keep/replace/remove;
  // without one, a non-empty secret means "set".
  const [totpChoice, setTotpChoice] = useState<'keep' | 'replace' | 'remove'>('keep');
  const [totpSecret, setTotpSecret] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [generatorOpen, setGeneratorOpen] = useState(false);

  const createMutation = useCreatePassword(org.id);
  const updateMutation = useUpdatePassword(org.id, original?.id ?? '');
  const busy = createMutation.isPending || updateMutation.isPending;

  const secretInPlay = hadTotp ? totpChoice === 'replace' : totpSecret.trim().length > 0;
  const secretValid = !secretInPlay || validateTotpSecret(totpSecret).ok;
  const urlError = optionalHttpUrlError(url);

  function totpState(): TotpFormState {
    if (hadTotp) {
      if (totpChoice === 'remove') return { kind: 'remove' };
      if (totpChoice === 'replace' && totpSecret.trim()) return { kind: 'set', secret: totpSecret };
      return { kind: 'keep' };
    }
    return totpSecret.trim() ? { kind: 'set', secret: totpSecret } : { kind: 'none' };
  }

  function formValues(): PasswordFormValues {
    return { name, username, password, url, notes, totp: totpState() };
  }

  const updatePayload = isEdit ? buildUpdatePayload(original, formValues()) : null;
  const saveDisabled =
    busy ||
    !secretValid ||
    urlError !== null ||
    (hadTotp && totpChoice === 'replace' && !totpSecret.trim()) ||
    (isEdit
      ? Object.keys(updatePayload!).length === 0
      : name.trim().length === 0 || password.length === 0);

  function checkTotp(): boolean {
    if (!secretInPlay) {
      setTotpError(null);
      return true;
    }
    const res = validateTotpSecret(totpSecret);
    setTotpError(res.ok ? null : res.message);
    return res.ok;
  }

  function describeError(err: unknown): string {
    if (err instanceof ApiError && typeof err.problem === 'object' && err.problem) {
      const detail = (err.problem as Record<string, unknown>).detail;
      if (typeof detail === 'string' && detail && detail !== 'ValidationError') {
        return detail;
      }
    }
    return isEdit ? 'Couldn’t save the changes.' : 'Couldn’t create the password.';
  }

  function onSave() {
    if (saveDisabled || !checkTotp()) return;
    setFormError(null);

    if (!isEdit) {
      createMutation.mutate(buildCreatePayload(formValues()), {
        onSuccess: (detail) => {
          toast.push('Password created', 'ok');
          // Replace, so back from the new detail lands on the list,
          // not a stale form.
          navigate({ to: `/passwords/${detail.id}`, replace: true });
        },
        onError: (err) => setFormError(describeError(err)),
      });
      return;
    }

    updateMutation.mutate(updatePayload!, {
      onSuccess: () => {
        toast.push('Password saved', 'ok');
        onCancel(); // back to detail
      },
      onError: (err) => setFormError(describeError(err)),
    });
  }

  // Password-manager suppression, ported from desktop's SecretInput:
  // Safari/1Password/Bitwarden must not offer to vault a credential the
  // user is saving INTO the vault.
  const pmSuppress = {
    autoComplete: 'off',
    autoCapitalize: 'none',
    autoCorrect: 'off',
    spellCheck: false,
    'data-lpignore': 'true',
    'data-1p-ignore': '',
    'data-bwignore': 'true',
    'data-form-type': 'other',
  } as const;

  return (
    <>
      <FormScreenChrome
        title={isEdit ? 'Edit password' : 'New password'}
        onCancel={onCancel}
        saveLabel={busy ? 'Saving…' : 'Save'}
        saveDisabled={saveDisabled}
        onSave={onSave}
      >
        {!isEdit && (
          <Card className="border-0 bg-accent-soft px-4 py-3.5 text-[15px] leading-relaxed text-accent-deep">
            Just set this on a device? Log it now — it saves to{' '}
            <strong className="font-semibold">{org.name}</strong>.
          </Card>
        )}

        {formError && <ErrorBanner title={formError} />}

        <FieldBlock label="Name" htmlFor="pw-name">
          <Input
            id="pw-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            placeholder="e.g. Router admin"
          />
        </FieldBlock>

        <FieldBlock label="Username" htmlFor="pw-username">
          <Input
            id="pw-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            maxLength={200}
            className="text-left font-mono tracking-normal"
            {...pmSuppress}
          />
        </FieldBlock>

        <FieldBlock
          label={isEdit ? 'New password' : 'Password'}
          htmlFor="pw-password"
          hint={isEdit ? 'Leave blank to keep the current password.' : undefined}
        >
          <div className="relative">
            <Input
              id="pw-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              maxLength={1024}
              className="pr-[104px] text-left font-mono tracking-normal"
              // Masked via text-security rather than type=password so
              // iOS never offers to save it to iCloud Keychain.
              style={{ WebkitTextSecurity: showPassword ? 'none' : 'disc' } as never}
              {...pmSuppress}
            />
            <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 gap-1">
              <button
                type="button"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowPassword((s) => !s)}
                className="flex h-10 w-10 items-center justify-center rounded-btn bg-panel text-text-2 active:bg-panel-2"
              >
                <Icon name={showPassword ? 'visibility_off' : 'visibility'} size={20} />
              </button>
              <button
                type="button"
                aria-label="Generate password"
                onClick={() => setGeneratorOpen(true)}
                className="flex h-10 w-10 items-center justify-center rounded-btn bg-accent-soft text-accent-deep active:bg-accent-line"
              >
                <Icon name="casino" size={20} />
              </button>
            </div>
          </div>
        </FieldBlock>

        <FieldBlock label="URL" htmlFor="pw-url" error={urlError}>
          <Input
            id="pw-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            maxLength={2048}
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://"
          />
        </FieldBlock>

        <FieldBlock label="Notes" htmlFor="pw-notes">
          <textarea
            id="pw-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={4}
            maxLength={50_000}
            className={
              'w-full resize-none rounded-field border border-line bg-surface p-4 ' +
              'text-body text-text outline-none placeholder:text-dim ' +
              'focus:border-2 focus:border-accent'
            }
          />
        </FieldBlock>

        {hadTotp ? (
          <FieldBlock label="One-time code" htmlFor="pw-totp">
            <div className="flex gap-2">
              {(['keep', 'replace', 'remove'] as const).map((choice) => (
                <button
                  key={choice}
                  type="button"
                  aria-pressed={totpChoice === choice}
                  onClick={() => {
                    setTotpChoice(choice);
                    setTotpError(null);
                  }}
                  className={
                    'h-chip flex-1 rounded-chip text-[15px] font-medium capitalize ' +
                    (totpChoice === choice
                      ? 'bg-text text-bg'
                      : 'border border-line bg-surface text-text-2 active:bg-panel-2')
                  }
                >
                  {choice}
                </button>
              ))}
            </div>
            {totpChoice === 'keep' && (
              <Hint>An authenticator is configured; it stays unchanged.</Hint>
            )}
            {totpChoice === 'remove' && (
              <Hint>Removes the authenticator from this credential.</Hint>
            )}
            {totpChoice === 'replace' && (
              <>
                <Input
                  id="pw-totp"
                  value={totpSecret}
                  onChange={(e) => setTotpSecret(e.target.value)}
                  onBlur={checkTotp}
                  placeholder="JBSWY3DPEHPK3PXP"
                  className="text-left font-mono tracking-normal"
                  {...pmSuppress}
                  autoCapitalize="characters"
                />
                {totpError && <FieldError message={totpError} />}
              </>
            )}
          </FieldBlock>
        ) : (
          <FieldBlock
            label="One-time code secret"
            htmlFor="pw-totp"
            hint="Optional — the base32 secret from the device’s authenticator setup."
          >
            <Input
              id="pw-totp"
              value={totpSecret}
              onChange={(e) => setTotpSecret(e.target.value)}
              onBlur={checkTotp}
              placeholder="JBSWY3DPEHPK3PXP"
              className="text-left font-mono tracking-normal"
              {...pmSuppress}
              autoCapitalize="characters"
            />
            {totpError && <FieldError message={totpError} />}
          </FieldBlock>
        )}
      </FormScreenChrome>

      <GeneratorSheet
        open={generatorOpen}
        onClose={() => setGeneratorOpen(false)}
        onUse={(generated) => {
          setPassword(generated);
          setShowPassword(true);
          setGeneratorOpen(false);
        }}
      />
    </>
  );
}

// FieldBlock/Hint/FieldError were promoted to `components/FieldBlock`
// in Phase 2c so the asset field editors share them.
