/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import MfaSetupClient from './mfa-setup-client';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const copyToClipboard = jest.fn();
const push = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: jest.fn() }) }));
jest.mock('../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('../../../lib/clipboard', () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}));
jest.mock('../../../components/ui', () => ({
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
  Field: ({
    label,
    htmlFor,
    error,
    children,
  }: {
    label: string;
    htmlFor?: string;
    error?: string;
    children: React.ReactNode;
  }) => (
    <>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error && <span role="alert">{error}</span>}
    </>
  ),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => toast,
}));

const ENROLL = {
  secret: 'JBSWY3DPEHPK3PXP',
  otpauthUrl: 'otpauth://totp/Weavestream:a@b.c?secret=JBSWY3DPEHPK3PXP',
  qrDataUrl: 'data:image/png;base64,abc',
};
// `as const` so indexing stays a literal under `noUncheckedIndexedAccess`.
const CODES = ['AAAAA-BBBBB', 'CCCCC-DDDDD'] as const;

const ACK_LABEL = /I.ve saved these codes somewhere safe/;

describe('MfaSetupClient', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    copyToClipboard.mockResolvedValue(true);
    apiFetch.mockImplementation(async (path: string) =>
      path === '/auth/mfa/enroll'
        ? { ok: true, status: 200, data: ENROLL }
        : { ok: true, status: 200, data: { ok: true, backupCodes: CODES } },
    );
  });

  /** Renders, waits for enrollment, then verifies to reach the code screen. */
  async function reachCodeScreen() {
    render(<MfaSetupClient />);
    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Verify & enable' }));
    });
    await waitFor(() => expect(screen.getByText(CODES[0])).toBeInTheDocument());
  }

  it('shows the codes with a shown-once warning', async () => {
    await reachCodeScreen();

    for (const code of CODES) expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getByText('Shown once — copy them now.')).toBeInTheDocument();
  });

  it('blocks Continue until the codes are acknowledged', async () => {
    await reachCodeScreen();

    const cont = screen.getByRole('button', { name: 'Continue' });
    expect(cont).toBeDisabled();

    fireEvent.click(cont);
    expect(push).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText(ACK_LABEL));
    expect(cont).toBeEnabled();

    fireEvent.click(cont);
    expect(push).toHaveBeenCalledWith('/');
  });

  it('copies the codes through the shared helper', async () => {
    await reachCodeScreen();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy codes' }));
    });

    expect(copyToClipboard).toHaveBeenCalledWith('AAAAA-BBBBB\nCCCCC-DDDDD');
    expect(toast.push).toHaveBeenCalledWith('Backup codes copied.', 'ok');
  });

  it('warns instead of failing silently when the code clipboard is unavailable', async () => {
    // The plain-HTTP LAN case — `navigator.clipboard` is undefined on a
    // non-secure origin and the old bare `catch {}` swallowed it.
    copyToClipboard.mockResolvedValue(false);
    await reachCodeScreen();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy codes' }));
    });

    expect(toast.push).toHaveBeenCalledWith(
      'Clipboard unavailable — copy them manually.',
      'warn',
    );
  });

  it('copies the TOTP secret through the shared helper', async () => {
    render(<MfaSetupClient />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: "Can't scan? Enter the secret manually" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: "Can't scan? Enter the secret manually" }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });

    expect(copyToClipboard).toHaveBeenCalledWith(ENROLL.secret);
    expect(toast.push).toHaveBeenCalledWith('Secret copied.', 'ok');
  });

  it('warns when the secret clipboard is unavailable', async () => {
    copyToClipboard.mockResolvedValue(false);
    render(<MfaSetupClient />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: "Can't scan? Enter the secret manually" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: "Can't scan? Enter the secret manually" }),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });

    expect(toast.push).toHaveBeenCalledWith(
      'Clipboard unavailable — copy it manually.',
      'warn',
    );
  });

  it('goes straight home when no codes are returned', async () => {
    // The non-first-time path: `/auth/mfa/verify` answers `{ ok: true }`
    // with no codes, so there is nothing to acknowledge.
    apiFetch.mockImplementation(async (path: string) =>
      path === '/auth/mfa/enroll'
        ? { ok: true, status: 200, data: ENROLL }
        : { ok: true, status: 200, data: { ok: true } },
    );
    render(<MfaSetupClient />);
    await waitFor(() => expect(screen.getByLabelText('6-digit code')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('6-digit code'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Verify & enable' }));
    });

    expect(push).toHaveBeenCalledWith('/');
  });
});
