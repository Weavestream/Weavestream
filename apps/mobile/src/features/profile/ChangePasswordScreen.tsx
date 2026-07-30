import {
  isCurrentPasswordInvalidProblem,
  passwordSchema,
} from '@weavestream/shared';
import { useState } from 'react';
import { FieldBlock } from '../../components/FieldBlock';
import { FormScreenChrome } from '../../components/FormScreenChrome';
import { useToast } from '../../components/Toast';
import { Input } from '../../components/primitives';
import { ErrorBanner } from '../../components/states';
import { ApiError } from '../../lib/api';
import { authError } from '../../lib/auth';
import { redirectToLogin } from '../../lib/navigate';
import { useBackOr } from '../../lib/use-back';
import { changeMyPassword } from './api';

/**
 * Change the account password (Phase 5c).
 *
 * Three properties of this screen are easy to get wrong and all three are
 * deliberate:
 *
 * 1. **Autocomplete is the opposite of the vault forms.** `PasswordFormScreen`
 *    suppresses password managers (`pmSuppress`, `WebkitTextSecurity`) because
 *    a *customer's* credential must not land in the technician's Keychain.
 *    This is the technician's own account password, so the manager should
 *    absolutely participate — real `type="password"` and the standard
 *    autocomplete tokens, matching `LoginScreen` and `StepUpHost`.
 *
 * 2. **The 401 branch.** This route 401s both for a wrong current password
 *    and for a dead session. `CURRENT_PASSWORD_INVALID_CODE` tells them
 *    apart; without the split, a typo would sign the technician out mid-job.
 *    That is also why the request is an imperative `apiFetch` rather than a
 *    mutation (see `./api`).
 *
 * 3. **The fields live in a real `<form>` whose submit button is the header
 *    Save**, associated across the DOM by `form={FORM_ID}`. Two separate
 *    reasons, and neither is satisfied by a `type="button"` that calls
 *    `requestSubmit()`:
 *      - Safari's AutoFill heuristics read form structure, so three loose
 *        inputs make "offer to save this password" unreliable.
 *      - Enter/Go from the keyboard only works if the form has a real submit
 *        button. Per the HTML implicit-submission algorithm, a form with
 *        more than one field that blocks implicit submission — and three
 *        password inputs are three such fields — and *no* submit button does
 *        nothing at all on Enter.
 *
 * 4. **Save gating is explicit.** Nothing on these inputs is `required`, so
 *    no native validation stands between an empty field and the API.
 *    `saveDisabled` is the affordance — and, because a disabled default
 *    button is skipped by the implicit-submission algorithm, it gates the
 *    keyboard too — while the early return in `submit` is the protection.
 */

/** Ties the header Save to the form below it. */
const FORM_ID = 'change-password-form';

export function ChangePasswordScreen() {
  const toast = useToast();
  const back = useBackOr('/profile');

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [currentError, setCurrentError] = useState<string | null>(null);
  const [nextError, setNextError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // `.length === 0`, NEVER `.trim().length === 0`: a password of spaces is
  // legal and is sent verbatim, so trimming here would silently corrupt it.
  // `busy` in the predicate is what stops a double-submit against the
  // route's 10-per-60s throttle.
  const saveDisabled =
    busy || current.length === 0 || next.length === 0 || confirm.length === 0;

  function submit() {
    if (saveDisabled) return;

    setFormError(null);
    setCurrentError(null);
    setNextError(null);
    setConfirmError(null);

    if (next !== confirm) {
      setConfirmError('Passwords don’t match.');
      return;
    }
    const parsed = passwordSchema.safeParse(next);
    if (!parsed.success) {
      setNextError(parsed.error.issues[0]?.message ?? 'Choose a stronger password.');
      return;
    }

    setBusy(true);
    void changeMyPassword({ currentPassword: current, newPassword: next })
      .then(() => {
        // Clear before navigating: nothing should sit in state once the
        // change has landed.
        setCurrent('');
        setNext('');
        setConfirm('');
        // The server keeps THIS session and revokes every other one, so the
        // copy has to say so — the technician's other devices just signed
        // out and they should not discover that later.
        toast.push('Password updated. Other sessions signed out.', 'ok');
        // `back()`, NOT a replace-navigation to `/profile`. A replace
        // deliberately INHERITS `upIsBack`/`backLabel` from the entry it
        // stands in for (scoped-nav: same stack position), so replacing this
        // form with `/profile` would stamp the profile entry `backLabel:
        // 'Profile'` — its own header would then read "‹ Profile" and Back
        // would land on the earlier profile entry instead of More. `back()`
        // pops when we arrived from the profile and replace-navigates only
        // on a cold link, where there is no stamp to inherit. Same path as
        // Cancel, which is also the right symmetry.
        back();
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          if (isCurrentPasswordInvalidProblem(err.problem)) {
            setCurrentError('Current password is incorrect.');
            return;
          }
          // No code: the session itself is gone (`AuthGuard` raises a bare
          // 401 only after `silentRefresh` has already failed), so there is
          // nothing to retry here and no probe request needed to be sure.
          redirectToLogin();
          return;
        }
        setFormError(authError(err, 'Current password is incorrect.'));
      })
      .finally(() => setBusy(false));
  }

  return (
    <FormScreenChrome
      title="Change password"
      onCancel={back}
      saveLabel={busy ? 'Saving…' : 'Save'}
      saveDisabled={saveDisabled}
      // Not `onSave`: this makes the header button the form's real submit
      // control, which is what the keyboard needs. See note 3 above.
      submitFor={FORM_ID}
    >
      <form
        id={FORM_ID}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-4"
      >
        {formError && <ErrorBanner title={formError} />}

        <FieldBlock
          label="Current password"
          htmlFor="current-password"
          error={currentError}
        >
          <Input
            id="current-password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </FieldBlock>

        <FieldBlock
          label="New password"
          htmlFor="new-password"
          error={nextError}
          hint="At least 12 characters, using 3 of: lowercase, uppercase, digit, symbol."
        >
          <Input
            id="new-password"
            name="new-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </FieldBlock>

        <FieldBlock
          label="Confirm new password"
          htmlFor="confirm-password"
          error={confirmError}
          hint="Your other devices are signed out when the password changes."
        >
          <Input
            id="confirm-password"
            name="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </FieldBlock>
      </form>
    </FormScreenChrome>
  );
}
