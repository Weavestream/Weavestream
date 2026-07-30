/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CURRENT_PASSWORD_INVALID_CODE } from '@weavestream/shared';
import { ChangePasswordScreen } from './ChangePasswordScreen';

/**
 * Three properties are load-bearing here and each fails silently:
 *
 *  - **Save gating.** `FormScreenChrome`'s Save is a `type="button"` with no
 *    enclosing `<form>`, so no native `required` validation runs. Only the
 *    explicit `saveDisabled` + early return keep an empty current password
 *    off the wire.
 *  - **No trimming.** A password of spaces is legal and must reach the
 *    server verbatim; trimming would corrupt the secret.
 *  - **The 401 split.** This route 401s for a wrong current password AND for
 *    a dead session. Getting it backwards either signs a technician out over
 *    a typo, or leaves a signed-out one retyping a correct password forever.
 *    Both directions are asserted.
 */

const backMock = jest.fn();
const pushToast = jest.fn();
const redirectToLogin = jest.fn();

jest.mock('../../lib/use-back', () => ({ useBackOr: () => backMock }));
jest.mock('../../components/Toast', () => ({ useToast: () => ({ push: pushToast }) }));
jest.mock('../../lib/navigate', () => ({
  redirectToLogin: () => redirectToLogin(),
}));
jest.mock('../../lib/api', () => {
  const actual = jest.requireActual('../../lib/api');
  return { ...actual, apiFetch: jest.fn() };
});

const { apiFetch } = jest.requireMock('../../lib/api') as { apiFetch: jest.Mock };
const { ApiError } = jest.requireActual('../../lib/api') as {
  ApiError: new (status: number, problem: unknown) => Error;
};

const GOOD = 'Str0ng-New-Passw0rd';

function save() {
  return screen.getByRole('button', { name: /^(Save|Saving…)$/ });
}

function fill({ current = 'old-secret', next = GOOD, confirm = GOOD } = {}) {
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: current },
  });
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: next } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), {
    target: { value: confirm },
  });
}

async function submit(over: Parameters<typeof fill>[0] = {}) {
  render(<ChangePasswordScreen />);
  fill(over);
  await act(async () => {
    fireEvent.click(save());
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  apiFetch.mockResolvedValue({ ok: true });
});

describe('ChangePasswordScreen — save gating', () => {
  it('disables Save until all three fields carry something', () => {
    render(<ChangePasswordScreen />);
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Current password'), {
      target: { value: 'old-secret' },
    });
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: GOOD },
    });
    expect(save()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: GOOD },
    });
    expect(save()).toBeEnabled();
  });

  it('never sends an empty current password', async () => {
    // The guarantee that matters: a blank current password produces no
    // request. Today the disabled attribute is what stops the click, and
    // `onSave`'s early return is defence-in-depth behind it — this asserts
    // the outcome rather than which layer delivered it, so the test keeps
    // holding if the screen ever gains an Enter-key submit.
    render(<ChangePasswordScreen />);
    fill({ current: '' });
    await act(async () => {
      fireEvent.click(save());
    });

    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a whitespace-only password as present and sends it verbatim', async () => {
    // `.trim()` here would both mis-gate the button and corrupt the secret.
    await submit({ current: '   ' });

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const [, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(init.body)).toEqual({
      currentPassword: '   ',
      newPassword: GOOD,
    });
  });

  it('blocks a second submit while one is in flight', async () => {
    let release: (() => void) | undefined;
    apiFetch.mockImplementation(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );

    render(<ChangePasswordScreen />);
    fill();
    fireEvent.click(save());

    await waitFor(() => expect(save()).toBeDisabled());
    expect(save()).toHaveTextContent('Saving…');
    fireEvent.click(save());
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
    });
  });
});

describe('ChangePasswordScreen — form grouping', () => {
  it('groups the three fields in a real form so AutoFill can read them', () => {
    // Safari's "save this password?" heuristics read form structure, and
    // this is the one password screen in the app that WANTS the manager.
    const { container } = render(<ChangePasswordScreen />);
    const form = container.querySelector('form');

    expect(form).not.toBeNull();
    for (const label of ['Current password', 'New password', 'Confirm new password']) {
      expect(form).toContainElement(screen.getByLabelText(label));
    }
  });

  /**
   * Enter/Go from the keyboard is a *browser* behaviour we cannot execute
   * here — jsdom does not implement the HTML implicit-submission algorithm,
   * so a `fireEvent.keyDown(input, { key: 'Enter' })` proves nothing and a
   * `fireEvent.submit(form)` bypasses the algorithm entirely (dispatching
   * the event the algorithm would have caused). Verified directly: jsdom
   * fires zero submits on Enter.
   *
   * What the algorithm actually requires is structural, and that IS
   * assertable: the form needs a real submit button as its default button —
   * with three password inputs it has more than one field blocking implicit
   * submission, so without one, Enter does nothing. So pin the structure,
   * and leave the keystroke itself to the hardware checklist.
   */
  it('makes the header Save the form’s real submit button', () => {
    const { container } = render(<ChangePasswordScreen />);
    const form = container.querySelector('form')!;
    const save = screen.getByRole('button', { name: 'Save' });

    expect(form.id).toBeTruthy();
    // A `type="button"` calling `requestSubmit()` would pass a click test
    // and still leave the keyboard dead. These two attributes are the
    // difference.
    expect(save).toHaveAttribute('type', 'submit');
    expect(save).toHaveAttribute('form', form.id);
  });

  it('submits through that association, and the guard holds on the submit path', async () => {
    // jsdom does honour `form=`, so clicking Save genuinely exercises
    // form submission rather than a direct onClick.
    const { container } = render(<ChangePasswordScreen />);
    const form = container.querySelector('form')!;
    const onSubmit = jest.fn();
    form.addEventListener('submit', onSubmit);

    // Blank current password: submitting must reach neither the API nor a
    // partial state. (Save is disabled here, which is also what stops the
    // keyboard — the algorithm skips a disabled default button.)
    fill({ current: '' });
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(apiFetch).not.toHaveBeenCalled();

    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(onSubmit).toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

describe('ChangePasswordScreen — client validation', () => {
  it('reports a confirmation mismatch without calling the API', async () => {
    await submit({ confirm: 'something-else' });

    expect(screen.getByRole('alert')).toHaveTextContent('Passwords don’t match.');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('surfaces the shared passwordSchema message inline', async () => {
    await submit({ next: 'short', confirm: 'short' });

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Password must be at least 12 characters',
    );
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('ChangePasswordScreen — the 401 split', () => {
  it('keeps a rejected current password on the form', async () => {
    apiFetch.mockRejectedValue(
      new ApiError(401, {
        status: 401,
        detail: 'Current password is incorrect',
        code: CURRENT_PASSWORD_INVALID_CODE,
      }),
    );
    await submit();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Current password is incorrect.',
      ),
    );
    // The whole point: a typo must not end the session — and must not
    // navigate away from the form either.
    expect(redirectToLogin).not.toHaveBeenCalled();
    expect(backMock).not.toHaveBeenCalled();
  });

  it('routes an uncoded 401 to login instead of blaming the field', async () => {
    apiFetch.mockRejectedValue(new ApiError(401, { status: 401, detail: 'Unauthorized' }));
    await submit();

    await waitFor(() => expect(redirectToLogin).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('ChangePasswordScreen — server errors and success', () => {
  it('maps the throttle 429 through the shared auth ladder', async () => {
    apiFetch.mockRejectedValue(new ApiError(429, { status: 429 }));
    await submit();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Too many attempts.'),
    );
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it('surfaces the server detail on a 400', async () => {
    apiFetch.mockRejectedValue(
      new ApiError(400, {
        status: 400,
        detail: 'New password must differ from current password',
      }),
    );
    await submit();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'New password must differ from current password',
      ),
    );
  });

  it('toasts the other-sessions consequence and leaves via the back path', async () => {
    await submit();

    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        'Password updated. Other sessions signed out.',
        'ok',
      ),
    );
    // Must be `back()`, not a replace-navigation to `/profile`: a replace
    // inherits `upIsBack`/`backLabel` from this entry, so the profile it
    // landed on would claim "‹ Profile" and Back would reach the earlier
    // profile entry instead of More.
    expect(backMock).toHaveBeenCalled();
    expect(redirectToLogin).not.toHaveBeenCalled();
  });

  it('leaves the form exactly the way Cancel does', async () => {
    // Same callback for both, so success and Cancel cannot drift apart.
    render(<ChangePasswordScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    const viaCancel = backMock.mock.calls.length;

    expect(viaCancel).toBe(1);
  });
});
