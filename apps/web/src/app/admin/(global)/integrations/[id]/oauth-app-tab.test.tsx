/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { IntegrationOAuthApp } from '@weavestream/shared';
import { ToastProvider } from '../../../../../components/ui';
import { IntegrationOAuthAppCard, OAuthAppTab } from './oauth-app-tab';

const apiFetch = jest.fn();
const copyToClipboard = jest.fn();

jest.mock('../../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('@weavestream/shared/browser', () => ({
  copyToClipboard: (...a: unknown[]) => copyToClipboard(...a),
}));

const ID = '00000000-0000-4000-8000-0000000000a1';
const REDIRECT = 'https://ws.example.test/api/v1/admin/integrations/oauth/callback';

function app(over: Partial<IntegrationOAuthApp> = {}): IntegrationOAuthApp {
  return {
    provider: 'google',
    configured: false,
    clientId: null,
    secretMask: null,
    callbackHostWarning: null,
    redirectUri: REDIRECT,
    scopes: ['openid', 'scope.read', 'scope.extra'],
    scopeGroups: [
      { label: 'Required', scopes: ['openid', 'scope.read'] },
      { label: 'Only if you use Example Tool', scopes: ['scope.extra'] },
    ],
    updatedAt: null,
    secretExpiresAt: null,
    secretExpiryWarning: null,
    tenantId: null,
    ...over,
  };
}

function renderCard(initial: IntegrationOAuthApp | null, provider: IntegrationOAuthApp['provider'] = 'google') {
  render(
    <ToastProvider>
      <IntegrationOAuthAppCard integrationId={ID} initial={initial} provider={provider} />
    </ToastProvider>,
  );
}

const msApp = (over: Partial<IntegrationOAuthApp> = {}) =>
  app({
    provider: 'microsoft',
    scopes: ['User.Read.All', 'AuditLog.Read.All', 'ReportSettings.ReadWrite.All'],
    scopeGroups: [
      { label: 'Directory, licences and domains', scopes: ['User.Read.All'] },
      { label: 'Sign-ins, MFA and usage reports', scopes: ['AuditLog.Read.All'] },
      { label: 'Report names setting (changed only if an admin chooses to)', scopes: ['ReportSettings.ReadWrite.All'] },
    ],
    ...over,
  });

describe('IntegrationOAuthAppCard (Microsoft app)', () => {
  it('titles the card, groups the application permissions and gives each its own copy button', async () => {
    renderCard(msApp(), 'microsoft');
    expect(screen.getByText('Microsoft app')).toBeInTheDocument();
    expect(screen.getByText('Application permissions')).toBeInTheDocument();
    expect(screen.getByText('Report names setting (changed only if an admin chooses to)')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy scope AuditLog.Read.All' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('AuditLog.Read.All');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy redirect uri (web)' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith(REDIRECT);
  });

  it('saves the client, write-only secret, expiry date and directory tenant id', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: msApp({ configured: true, clientId: 'client-1', secretMask: '••••f456', secretExpiresAt: '2027-04-01' }) });
    renderCard(msApp(), 'microsoft');
    fireEvent.change(screen.getByLabelText('Application (client) ID'), { target: { value: 'client-1' } });
    fireEvent.change(screen.getByLabelText('Client secret value'), { target: { value: 'typed-secret' } });
    fireEvent.change(screen.getByLabelText('Secret expires'), { target: { value: '2027-04-01' } });
    fireEvent.change(screen.getByLabelText('Directory (tenant) ID (optional)'), { target: { value: '11111111-2222-4333-8444-555555555555' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save Microsoft app' }));
    });
    expect(apiFetch).toHaveBeenCalledWith(`/admin/integrations/${ID}/oauth-app`, {
      method: 'PUT',
      body: JSON.stringify({
        clientId: 'client-1',
        clientSecret: 'typed-secret',
        secretExpiresAt: '2027-04-01',
        tenantId: '11111111-2222-4333-8444-555555555555',
      }),
    });
    expect(screen.getByLabelText('Client secret value')).toHaveValue('');
  });

  it('lets a configured app save only a new expiry date', async () => {
    const configured = msApp({ configured: true, clientId: 'client-1', secretMask: '••••f456', secretExpiresAt: '2026-10-20' });
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: configured });
    renderCard(configured, 'microsoft');
    const save = screen.getByRole('button', { name: 'Save Microsoft app' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Secret expires'), { target: { value: '2028-10-20' } });
    expect(save).toBeEnabled();
  });

  it('shows the secret expiry warning', () => {
    renderCard(msApp({ secretExpiryWarning: 'The client secret expires on 2026-10-20 (in 11 days).' }), 'microsoft');
    expect(screen.getByRole('alert')).toHaveTextContent('expires on 2026-10-20');
  });
});

beforeEach(() => {
  apiFetch.mockReset();
  copyToClipboard.mockReset().mockResolvedValue(true);
});

describe('IntegrationOAuthAppCard', () => {
  it('shows the redirect URI, and every scope with its own copy button, grouped', async () => {
    renderCard(app());
    expect(screen.getByText(REDIRECT)).toBeInTheDocument();
    expect(screen.getByText('not configured')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy authorized redirect uri' }));
    });
    expect(copyToClipboard).toHaveBeenCalledWith(REDIRECT);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy scope scope.read' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('scope.read');
    expect(screen.getByText('Only if you use Example Tool')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy scope scope.extra' }));
    });
    expect(copyToClipboard).toHaveBeenLastCalledWith('scope.extra');
  });

  it('saves through the step-up route and clears the write-only secret', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: app({ configured: true, clientId: 'client-1', secretMask: '••••f456' }),
    });
    renderCard(app());
    const save = screen.getByRole('button', { name: 'Save OAuth app' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: ' client-1 ' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'typed-secret' } });
    await act(async () => {
      fireEvent.click(save);
    });
    expect(apiFetch).toHaveBeenCalledWith(`/admin/integrations/${ID}/oauth-app`, {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'client-1', clientSecret: 'typed-secret' }),
    });
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
    expect(screen.getByText(/ends in ••••f456/)).toBeInTheDocument();
    expect(screen.getByText('configured')).toBeInTheDocument();
  });

  it('saves a changed client ID without re-entering a stored secret', async () => {
    const configured = app({ configured: true, clientId: 'client-1', secretMask: '••••f456' });
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { ...configured, clientId: 'client-2' } });
    renderCard(configured);
    const save = screen.getByRole('button', { name: 'Save OAuth app' });
    // Nothing changed yet: nothing to save.
    expect(save).toBeDisabled();
    expect(screen.getByText(/Leave blank to keep it/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-2' } });
    expect(save).toBeEnabled();
    await act(async () => {
      fireEvent.click(save);
    });
    expect(apiFetch).toHaveBeenCalledWith(`/admin/integrations/${ID}/oauth-app`, {
      method: 'PUT',
      body: JSON.stringify({ clientId: 'client-2' }),
    });
  });

  it('stays silent when the step-up prompt is dismissed', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, data: null, stepUpCancelled: true });
    renderCard(app());
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-1' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'typed-secret' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save OAuth app' }));
    });
    expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();
    expect(screen.getByText('not configured')).toBeInTheDocument();
  });

  it('explains when scopes are not known yet, and when loading failed', () => {
    renderCard(app({ scopes: [], scopeGroups: [] }));
    expect(screen.getByText(/requests no scopes/)).toBeInTheDocument();
  });

  it('shows a load error without the form', () => {
    renderCard(null);
    expect(screen.getByText(/Could not load the Google OAuth app/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument();
  });

  it('renders the setup guide and runs Check setup, turning passed steps green', async () => {
    const guide = [
      { id: 'client', title: 'Create the OAuth client', body: 'Create it.' },
      { id: 'credentials', title: 'Paste the client', body: 'Paste it.' },
    ];
    apiFetch.mockResolvedValue({
      ok: true, status: 200,
      data: { ok: false, passedStepIds: ['client'], failures: [{ stepId: 'credentials', message: 'Copy both again.' }] },
    });
    renderCard(app({ configured: true, clientId: 'client-1', secretMask: '••••', setupGuide: guide }));
    // Configured: the guide starts collapsed.
    fireEvent.click(screen.getByRole('button', { name: /Setup guide/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check setup/ }));
    });
    expect(apiFetch).toHaveBeenCalledWith(`/admin/integrations/${ID}/oauth-app/check`, { method: 'POST', body: '{}' });
    expect(screen.getByText('Copy both again.')).toBeInTheDocument();
    const states = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-state')).map((li) => li.getAttribute('data-state'));
    expect(states).toEqual(['passed', 'failed']);
  });

  it('disables Check setup until the app is saved', () => {
    renderCard(app({ setupGuide: [{ id: 'project', title: 'Create a project', body: 'Do it.' }] }));
    expect(screen.getByText('Create a project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check setup/ })).toBeDisabled();
  });

  it('warns when API_URL and APP_URL are on different hosts', () => {
    const warning = 'API_URL and APP_URL must share a host for Connect with Google to keep you signed in.';
    renderCard(app({ callbackHostWarning: warning }));
    expect(screen.getByText(warning)).toBeInTheDocument();
  });

  it('shows no host warning on a same-host install', () => {
    renderCard(app());
    expect(screen.queryByText(/must share a host/)).not.toBeInTheDocument();
  });
});

describe('OAuthAppTab', () => {
  it('loads the app of this integration, then shows it', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: app({ configured: true, clientId: 'client-1', secretMask: '••••1234' }) });
    render(
      <ToastProvider>
        <OAuthAppTab integrationId={ID} provider="google" />
      </ToastProvider>,
    );
    expect(await screen.findByDisplayValue('client-1')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(`/admin/integrations/${ID}/oauth-app`);
  });

  it('shows the load failure instead of loading forever when the request throws', async () => {
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(
      <ToastProvider>
        <OAuthAppTab integrationId={ID} provider="google" />
      </ToastProvider>,
    );
    expect(await screen.findByText(/Could not load the .* settings/)).toBeInTheDocument();
  });
});
