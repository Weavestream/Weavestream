/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CURRENT_PASSWORD_INVALID_CODE } from '@weavestream/shared';
import { PasswordForm } from './password-form';

/**
 * `POST /me/change-password` 401s for two unrelated reasons, and `apiFetch`
 * has no 401 handling of its own, so this form owns the distinction:
 *
 *  - 401 **carrying** `current_password_invalid` — the field was wrong. Stay
 *    on the form and say so.
 *  - 401 **without** it — the session is gone (`AuthGuard` throws a bare one
 *    once `silentRefresh` has already failed). Route to login; rendering
 *    "Unauthorized" as a field error would leave the user retyping a correct
 *    password against a dead cookie.
 *
 * Both directions are asserted because either one alone can regress silently.
 */

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const push = jest.fn();
const refresh = jest.fn();

jest.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
jest.mock('../../components/ui', () => ({
  Btn: ({
    children,
    loading: _loading,
    kind: _kind,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  Field: ({
    label,
    htmlFor,
    error,
    children,
  }: {
    label?: string;
    htmlFor?: string;
    error?: string;
    children: React.ReactNode;
  }) => (
    // `data-field` mirrors which control the real `Field` would attach the
    // error to, so a test can assert placement and not just presence.
    <div data-field={label}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {error && <p role="alert">{error}</p>}
    </div>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  useToast: () => toast,
}));

const GOOD = 'Str0ng-New-Passw0rd';

/** Which field's `Field` block the visible error is rendered inside. */
function erroredField(): string | null {
  return screen.getByRole('alert').closest('[data-field]')?.getAttribute('data-field') ?? null;
}

/** Fill all three fields and submit, flushing the async handler. */
async function submit({ next = GOOD, confirm = GOOD } = {}) {
  render(<PasswordForm />);
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: 'whatever' },
  });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: confirm },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
  });
}

describe('PasswordForm — 401 discrimination', () => {
  beforeEach(() => jest.clearAllMocks());

  it('marks the current-password field, not the confirmation, and does not navigate', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 401,
      data: null,
      problem: {
        status: 401,
        detail: 'Current password is incorrect',
        code: CURRENT_PASSWORD_INVALID_CODE,
      },
    });
    await submit();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Current password is incorrect',
      ),
    );
    // Placement is the point: the code identifies the field precisely, so
    // showing this under "Confirm new password" would send the user to
    // retype the field that was already correct.
    expect(erroredField()).toBe('Current password');
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(toast.push).not.toHaveBeenCalled();
  });

  it('routes an uncoded 401 to login instead of blaming the field', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 401,
      data: null,
      problem: { status: 401, detail: 'Unauthorized' },
    });
    await submit();

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login'));
    // Without the refresh the cached `/me` RSC payload can re-render behind
    // the navigation.
    expect(refresh).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('still surfaces non-401 failures inline', async () => {
    // Guards against the new branch over-reaching: a 400 must not navigate.
    apiFetch.mockResolvedValue({
      ok: false,
      status: 400,
      data: null,
      problem: { status: 400, detail: 'New password must differ from current password' },
    });
    await submit();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'New password must differ from current password',
      ),
    );
    // Non-401 failures stay on the generic form error, unchanged.
    expect(erroredField()).toBe('Confirm new password');
    expect(push).not.toHaveBeenCalled();
  });

  it('reports a confirmation mismatch without calling the API', async () => {
    await submit({ confirm: 'something-else' });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'New password and confirmation do not match.',
    );
    expect(erroredField()).toBe('Confirm new password');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('clears the fields and toasts the other-sessions consequence on success', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    await submit();

    await waitFor(() =>
      expect(toast.push).toHaveBeenCalledWith(
        'Password updated. Other sessions signed out.',
        'ok',
      ),
    );
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(push).not.toHaveBeenCalled();
  });
});
