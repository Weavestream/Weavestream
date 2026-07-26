/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MfaBackupCodes } from './mfa-backup-codes';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const copyToClipboard = jest.fn();

jest.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@weavestream/shared/browser', () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}));
jest.mock('../../components/ui', () => ({
  Btn: ({
    children,
    loading: _loading,
    icon: _icon,
    kind: _kind,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({
    open,
    title,
    children,
    footer,
  }: {
    open: boolean;
    title: React.ReactNode;
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    open ? (
      <div role="dialog">
        <h2>{title}</h2>
        {children}
        {footer}
      </div>
    ) : null,
  Icon: { key: null },
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => toast,
}));

const CODES = ['AAAAA-BBBBB', 'CCCCC-DDDDD'];

describe('MfaBackupCodes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    copyToClipboard.mockResolvedValue(true);
  });

  // The click kicks off an async handler that setStates after awaiting, so
  // flush it inside `act` to keep React 19 from warning on every case.
  async function regenerate() {
    render(<MfaBackupCodes enabled />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Regenerate codes' }));
    });
  }

  // ── Characterization: unchanged behaviour ────────────────────────────
  it('renders the returned codes with the shown-once warning', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { backupCodes: CODES } });
    await regenerate();

    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    for (const code of CODES) expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getByText('Shown once — copy them now.')).toBeInTheDocument();
    expect(toast.push).not.toHaveBeenCalled();
  });

  it('still reports a genuine failure', async () => {
    // Guards against the cancellation branch over-narrowing and
    // swallowing real errors.
    apiFetch.mockResolvedValue({
      ok: false,
      status: 500,
      data: null,
      problem: { title: 'Internal Server Error' },
    });
    await regenerate();

    await waitFor(() =>
      expect(toast.push).toHaveBeenCalledWith('Could not regenerate backup codes.', 'danger'),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  // ── New behaviour ────────────────────────────────────────────────────
  it('says nothing when the user dismisses the step-up prompt', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      data: null,
      problem: { code: 'step_up_required', factor: 'mfa' },
      stepUpCancelled: true,
    });
    await regenerate();

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(toast.push).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('DOES report a step-up 403 that was not a dismissal', async () => {
    // Same problem body, no `stepUpCancelled` — provider missing, or a
    // retry that stayed blocked. Both are real failures.
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      data: null,
      problem: { code: 'step_up_required', factor: 'mfa' },
    });
    await regenerate();

    await waitFor(() =>
      expect(toast.push).toHaveBeenCalledWith('Could not regenerate backup codes.', 'danger'),
    );
  });

  it('copies through the shared helper and confirms', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { backupCodes: CODES } });
    await regenerate();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Copy codes' }));

    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith('AAAAA-BBBBB\nCCCCC-DDDDD'),
    );
    expect(toast.push).toHaveBeenCalledWith('Backup codes copied.', 'ok');
  });

  it('warns instead of failing silently when the clipboard is unavailable', async () => {
    // The plain-HTTP LAN case: previously a bare `catch {}` swallowed this
    // and the button simply never confirmed.
    copyToClipboard.mockResolvedValue(false);
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { backupCodes: CODES } });
    await regenerate();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Copy codes' }));

    await waitFor(() =>
      expect(toast.push).toHaveBeenCalledWith(
        'Clipboard unavailable — copy them manually.',
        'warn',
      ),
    );
  });
});
