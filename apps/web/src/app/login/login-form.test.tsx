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
  apiFetch.mockResolvedValue({ ok: true, status: 200, data: { user: { id: 'u', email: 'e' }, ...data } });
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
