/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ConsentClient, resumeUrl } from './consent-client';

const apiFetch = jest.fn();
jest.mock('../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

const UID = 'dxD8Ueeeemh4NVcpbl6FiTFOv5P09h5lCSWwz3p2l1M';
const DETAILS = {
  uid: UID,
  clientId: 'https://claude.ai/oauth/mcp-client-metadata',
  clientHost: 'claude.ai',
  clientName: 'Claude',
  redirectHost: 'claude.ai',
  user: { email: 'pat@example.com' },
};
const ORIGIN = window.location.origin;

describe('resumeUrl', () => {
  it('follows only the authorization server resume path on this origin', () => {
    expect(resumeUrl(`${ORIGIN}/api/v1/oauth/auth/${UID}`, ORIGIN)).toBe(`${ORIGIN}/api/v1/oauth/auth/${UID}`);
    expect(resumeUrl(`/api/v1/oauth/auth/${UID}`, ORIGIN)).toBe(`${ORIGIN}/api/v1/oauth/auth/${UID}`);
  });

  it.each([
    `https://evil.example/api/v1/oauth/auth/${UID}`,
    'https://claude.ai/api/mcp/auth_callback?code=x',
    `${ORIGIN}/admin`,
    `${ORIGIN}/api/v1/companies`,
    'javascript:alert(1)',
    42,
    null,
  ])('refuses %s', (value) => {
    expect(resumeUrl(value, ORIGIN)).toBeNull();
  });
});

describe('ConsentClient', () => {
  const assign = jest.fn();

  beforeEach(() => {
    apiFetch.mockReset();
    assign.mockReset();
  });

  async function renderLoaded() {
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: DETAILS });
    await act(async () => {
      render(<ConsentClient uid={UID} navigate={assign} />);
    });
  }

  it('shows the user, the verified app and return hosts, and defaults to read only', async () => {
    await renderLoaded();
    expect(apiFetch).toHaveBeenCalledWith(`/oauth-consent/${UID}/details`);
    expect(screen.getByText('pat@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('claude.ai')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: /Read only/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Read and change/ })).not.toBeChecked();
  });

  it('approves read only by default and follows the resume URL', async () => {
    await renderLoaded();
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { redirectTo: `${ORIGIN}/api/v1/oauth/auth/${UID}` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith(`/oauth-consent/${UID}/approve`, {
      method: 'POST',
      body: JSON.stringify({ allowWrite: false }),
    });
    expect(assign).toHaveBeenCalledWith(`${ORIGIN}/api/v1/oauth/auth/${UID}`);
  });

  it('sends allowWrite only when the user chose it', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('radio', { name: /Read and change/ }));
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { redirectTo: `/api/v1/oauth/auth/${UID}` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith(`/oauth-consent/${UID}/approve`, {
      method: 'POST',
      body: JSON.stringify({ allowWrite: true }),
    });
  });

  it('never navigates to a redirect outside the resume path', async () => {
    await renderLoaded();
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { redirectTo: 'https://evil.example/' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByText(/could not be completed/)).toBeInTheDocument();
  });

  it('stays put, quietly, when the step-up prompt is dismissed', async () => {
    await renderLoaded();
    apiFetch.mockResolvedValueOnce({ ok: false, status: 403, data: null, stepUpCancelled: true });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    });
    expect(assign).not.toHaveBeenCalled();
    expect(screen.queryByText(/Not connected/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('deny goes back to the app through the resume URL', async () => {
    await renderLoaded();
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: { redirectTo: `/api/v1/oauth/auth/${UID}` } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith(`/oauth-consent/${UID}/deny`, { method: 'POST', body: '{}' });
    expect(assign).toHaveBeenCalledWith(`${ORIGIN}/api/v1/oauth/auth/${UID}`);
  });

  it('explains an expired or foreign request instead of showing the form', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      data: null,
      problem: { detail: 'This connection request has expired or was started in another browser.' },
    });
    await act(async () => {
      render(<ConsentClient uid={UID} navigate={assign} />);
    });
    expect(screen.getByText(/expired or was started in another browser/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('shows a network failure while loading instead of staying on "Loading…"', async () => {
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => {
      render(<ConsentClient uid={UID} navigate={assign} />);
    });
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(screen.getByText(/could not be reached.*reload this page/)).toBeInTheDocument();
  });

  it.each(['Approve', 'Deny'])('%s: a network failure re-enables both buttons and says why', async (label) => {
    await renderLoaded();
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: label }));
    });
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByText(/could not be reached.*try again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled();
  });
});
