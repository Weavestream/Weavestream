/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SsoLink, SSO_LINK_HREF } from './sso-link';

const apiFetch = jest.fn();
const ensureStepUp = jest.fn();
const refresh = jest.fn();
const toast = { push: jest.fn() };

jest.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('../../lib/step-up', () => ({ ensureStepUp: () => ensureStepUp() }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('../../components/ui', () => ({
  Btn: ({
    children,
    loading: _loading,
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
  ErrorBanner: ({ title }: { title: string }) => <div role="alert">{title}</div>,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => toast,
}));

const UNLINKED = { enabled: true, linked: false, providerName: 'Contoso' };
const LINKED = { ...UNLINKED, linked: true };

describe('SsoLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ensureStepUp.mockResolvedValue(true);
  });

  it('offers to link when not linked, naming the provider', () => {
    render(<SsoLink status={UNLINKED} />);
    expect(screen.getByText('not linked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link Contoso account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Unlink' })).not.toBeInTheDocument();
  });

  it('runs the step-up first, then navigates the whole page to the API link route', async () => {
    const navigate = jest.fn();
    render(<SsoLink status={UNLINKED} navigate={navigate} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link Contoso account' }));
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(SSO_LINK_HREF));
    expect(ensureStepUp).toHaveBeenCalledTimes(1);
    expect(SSO_LINK_HREF).toBe('/api/v1/auth/sso/link');
    expect(ensureStepUp.mock.invocationCallOrder[0]).toBeLessThan(
      navigate.mock.invocationCallOrder[0]!,
    );
  });

  it('does not navigate when the step-up prompt is dismissed', async () => {
    ensureStepUp.mockResolvedValue(false);
    const navigate = jest.fn();
    render(<SsoLink status={UNLINKED} navigate={navigate} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Link Contoso account' }));
    });
    await waitFor(() => expect(ensureStepUp).toHaveBeenCalled());
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows linked status with an Unlink button instead of Link', () => {
    render(<SsoLink status={LINKED} />);
    expect(screen.getByText('linked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlink' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Link Contoso/ })).not.toBeInTheDocument();
  });

  it('asks for confirmation before unlinking, and Cancel does nothing', () => {
    render(<SsoLink status={LINKED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('unlinks with DELETE after confirmation, then refreshes', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    render(<SsoLink status={LINKED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unlink' }));
    });
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/auth/sso/link', { method: 'DELETE' }),
    );
    expect(toast.push).toHaveBeenCalledWith('Unlinked your Contoso account.', 'ok');
    expect(refresh).toHaveBeenCalled();
  });

  it('explains a refused unlink (409: no other way to sign in)', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 409, data: null });
    render(<SsoLink status={LINKED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unlink' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/Set a password before unlinking/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports a generic unlink failure', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, data: null });
    render(<SsoLink status={LINKED} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unlink' }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not unlink your Contoso account.');
  });

  describe('result messages for ?sso=', () => {
    it('linked: a success notice, no error', () => {
      render(<SsoLink status={LINKED} result="linked" />);
      expect(screen.getByRole('status')).toHaveTextContent('Your Contoso account is now linked.');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it.each([
      ['not_allowed', /already be linked to another user/],
      ['failed', /Linking failed/],
      ['no_account', /Linking failed/],
      ['expired', /took too long/],
    ])('%s shows its message', (code, pattern) => {
      render(<SsoLink status={UNLINKED} result={code} />);
      expect(screen.getByRole('alert')).toHaveTextContent(pattern);
    });

    it('an unknown value shows the generic failure, never the raw value', () => {
      render(<SsoLink status={UNLINKED} result="<script>x</script>" />);
      expect(screen.getByRole('alert')).toHaveTextContent('Linking failed. Please try again.');
      expect(screen.getByRole('alert')).not.toHaveTextContent('script');
    });

    it('no result shows no banner', () => {
      render(<SsoLink status={UNLINKED} result={null} />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });
});
