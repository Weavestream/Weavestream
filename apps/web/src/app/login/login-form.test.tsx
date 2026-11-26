/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import LoginForm from './login-form';

const apiFetch = jest.fn();
const push = jest.fn();
jest.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const CONSENT = '/oauth/consent/dxD8Ueeeemh4NVcpbl6FiTFOv5P09h5lCSWwz3p2l1M';

async function signIn(next: string | null, data: Record<string, boolean>) {
  apiFetch.mockResolvedValue({
    ok: true,
    status: 200,
    data: { user: { id: 'u', email: 'e' }, ...data },
  });
  render(<LoginForm next={next} />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret-secret' } });
  await act(async () => {
    fireEvent.submit(screen.getByLabelText('Email').closest('form')!);
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  push.mockReset();
});

describe('LoginForm return path', () => {
  it('carries the consent page through the MFA challenge', async () => {
    await signIn(CONSENT, { mfaSetupRequired: false, mfaChallengeRequired: true });
    expect(push).toHaveBeenCalledWith(`/mfa/challenge?next=${encodeURIComponent(CONSENT)}`);
  });

  it('carries it through MFA setup', async () => {
    await signIn(CONSENT, { mfaSetupRequired: true, mfaChallengeRequired: false });
    expect(push).toHaveBeenCalledWith(`/mfa/setup?next=${encodeURIComponent(CONSENT)}`);
  });

  it('goes straight back when no MFA step is pending', async () => {
    await signIn(CONSENT, { mfaSetupRequired: false, mfaChallengeRequired: false });
    expect(push).toHaveBeenCalledWith(CONSENT);
  });

  it('ignores anything that is not a consent path', async () => {
    await signIn('//evil.example', { mfaSetupRequired: false, mfaChallengeRequired: true });
    expect(push).toHaveBeenCalledWith('/mfa/challenge');
  });

  it('keeps the old behavior without a return path', async () => {
    await signIn(null, { mfaSetupRequired: false, mfaChallengeRequired: false });
    expect(push).toHaveBeenCalledWith('/');
  });
});

describe('LoginForm single sign-on', () => {
  function config(c: Record<string, unknown>) {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: c });
  }

  it('shows no SSO button when SSO is off', async () => {
    config({ enabled: false, providerName: 'Entra', localLoginEnabled: true });
    render(<LoginForm />);
    await screen.findByLabelText('Email');
    expect(apiFetch).toHaveBeenCalledWith('/auth/sso/config');
    expect(screen.queryByText(/Sign in with/)).not.toBeInTheDocument();
  });

  it('shows no SSO button when the config request fails', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 500, data: null });
    render(<LoginForm />);
    await act(async () => {});
    expect(screen.queryByText(/Sign in with/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('shows a full-navigation button to the fixed login path, with the local form', async () => {
    config({ enabled: true, providerName: 'Microsoft Entra ID', localLoginEnabled: true });
    render(<LoginForm next="/oauth/consent/abc" />);
    const link = await screen.findByRole('link', { name: 'Sign in with Microsoft Entra ID' });
    expect(link).toHaveAttribute('href', '/api/v1/auth/sso/login');
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('hides the local form until "Use a local account" is clicked', async () => {
    config({ enabled: true, providerName: 'Entra', localLoginEnabled: false });
    render(<LoginForm />);
    await screen.findByRole('link', { name: 'Sign in with Entra' });
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use a local account' }));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in with Entra' })).toBeInTheDocument();
  });

  it.each([
    ['no_account', /No Weavestream account/],
    ['not_allowed', /not allowed to sign in/],
    ['failed', /Single sign-on failed/],
    ['expired', /expired/],
    ['something_else', /Single sign-on failed/],
  ])('shows a message for sso_error=%s', async (code, text) => {
    config({ enabled: false, providerName: 'Entra', localLoginEnabled: true });
    render(<LoginForm ssoError={code} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('shows no message without an sso_error', async () => {
    config({ enabled: false, providerName: 'Entra', localLoginEnabled: true });
    render(<LoginForm />);
    await screen.findByLabelText('Email');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
