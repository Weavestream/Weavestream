/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SsoSettings } from '@weavestream/shared';
import { ToastProvider } from '../../../../components/ui';
import { SsoSettingsForm } from './sso-settings-form';

const apiFetch = jest.fn();
jest.mock('../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const TENANT = '11111111-2222-3333-4444-555555555555';
const CALLBACK = 'https://wiki.example.test/api/v1/auth/sso/callback';
// Fictional placeholder, not a credential.
const NEW_SECRET = 'placeholder-new-secret';

const BASE: SsoSettings = {
  source: 'database',
  envKeysSet: [],
  enabled: false,
  providerName: 'Single sign-on',
  issuer: null,
  clientId: null,
  clientSecretSet: false,
  scopes: 'openid profile email',
  allowedTenantId: null,
  linkByEmail: false,
  autoProvision: false,
  trustIdpMfa: false,
  assumeIdpMfa: false,
  localLoginEnabled: true,
  callbackUrl: CALLBACK,
  updatedAt: null,
};

const CONFIGURED: SsoSettings = {
  ...BASE,
  enabled: true,
  providerName: 'Contoso',
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  clientId: 'client-id',
  clientSecretSet: true,
};

function renderForm(overrides: Partial<SsoSettings> = {}) {
  render(
    <ToastProvider>
      <SsoSettingsForm initial={{ ...BASE, ...overrides }} />
    </ToastProvider>,
  );
}

async function click(name: string | RegExp) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const lastBody = () => JSON.parse(apiFetch.mock.calls.at(-1)![1].body);

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string, options: { body: string }) => {
    if (path === '/settings/sso/test') {
      return {
        ok: true,
        data: {
          ok: true,
          issuer: 'x',
          callbackUrl: CALLBACK,
          discoveryReachable: true,
          issuerMatches: true,
          authorizationEndpoint: 'https://idp.example.test/authorize',
          tokenEndpoint: 'https://idp.example.test/token',
          jwksUri: 'https://idp.example.test/keys',
          jwksReachable: true,
          message: 'Connected. The provider answered and its issuer matches.',
        },
      };
    }
    const p = JSON.parse(options.body);
    return {
      ok: true,
      data: { ...CONFIGURED, ...p, clientSecretSet: !p.clearClientSecret, clientSecret: undefined },
    };
  });
});

describe('environment-managed (read-only) mode', () => {
  const env: Partial<SsoSettings> = {
    source: 'env',
    envKeysSet: ['SSO_OIDC_ISSUER', 'SSO_OIDC_CLIENT_SECRET'],
    enabled: true,
    issuer: CONFIGURED.issuer,
    clientId: 'client-id',
    clientSecretSet: true,
  };

  it('shows the banner listing the variable NAMES that are set', () => {
    renderForm(env);
    expect(screen.getByText('Managed by environment variables')).toBeInTheDocument();
    expect(screen.getAllByText('SSO_OIDC_ISSUER').length).toBeGreaterThan(0);
    expect(screen.getByText('SSO_OIDC_CLIENT_SECRET')).toBeInTheDocument();
    // Names only: no env VALUE (issuer URL, client id) is rendered as text.
    expect(screen.queryByText(new RegExp(TENANT))).not.toBeInTheDocument();
  });

  it('disables every input, offers no save, and offers no secret Replace/Clear', () => {
    renderForm(env);
    expect(screen.getByLabelText('Issuer URL')).toBeDisabled();
    expect(screen.getByLabelText('Client ID')).toBeDisabled();
    expect(screen.getByLabelText('Provider name')).toBeDisabled();
    expect(screen.getByLabelText(/Enable single sign-on/)).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save single sign-on settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
    expect(screen.getByText('Secret set')).toBeInTheDocument();
  });

  it('still lets you test the saved connection, sending no issuer override', async () => {
    renderForm(env);
    await click('Test connection');
    expect(apiFetch.mock.calls[0]![0]).toBe('/settings/sso/test');
    expect(lastBody()).toEqual({});
  });

  it('is not shown in database mode', () => {
    renderForm();
    expect(screen.queryByText('Managed by environment variables')).not.toBeInTheDocument();
  });
});

describe('client secret is write-only', () => {
  it('shows "Secret set" with Replace and Clear, and no value anywhere', () => {
    renderForm(CONFIGURED);
    expect(screen.getByText('Secret set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Client secret value')).not.toBeInTheDocument();
  });

  it('omits the secret from the request when it is not touched (keep)', async () => {
    renderForm(CONFIGURED);
    type('Provider name', 'Fabrikam');
    await click('Save single sign-on settings');
    expect(lastBody()).not.toHaveProperty('clientSecret');
    expect(lastBody()).not.toHaveProperty('clearClientSecret');
  });

  it('sends a replacement secret, then clears the input and goes back to "Secret set"', async () => {
    renderForm(CONFIGURED);
    await click('Replace');
    type('Client secret value', NEW_SECRET);
    await click('Save single sign-on settings');
    expect(lastBody().clientSecret).toBe(NEW_SECRET);
    expect(screen.queryByDisplayValue(NEW_SECRET)).not.toBeInTheDocument();
    expect(screen.getByText('Secret set')).toBeInTheDocument();
  });

  it('sends an explicit clear, and Undo cancels it', async () => {
    renderForm({ ...CONFIGURED, enabled: false });
    await click('Clear');
    expect(screen.getByText('Secret will be removed when you save')).toBeInTheDocument();
    await click('Undo');
    expect(screen.getByText('Secret set')).toBeInTheDocument();
    await click('Clear');
    await click('Save single sign-on settings');
    expect(lastBody()).toMatchObject({ clearClientSecret: true });
    expect(lastBody()).not.toHaveProperty('clientSecret');
  });

  it('uses a password input for entering the secret', () => {
    renderForm();
    expect(screen.getByLabelText('Client secret value')).toHaveAttribute('type', 'password');
  });
});

describe('callback URL', () => {
  it('is shown read-only and copyable', async () => {
    const writeText = jest.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderForm();
    const input = screen.getByLabelText('Callback URL');
    expect(input).toHaveValue(CALLBACK);
    expect(input).toHaveAttribute('readonly');
    await click('Copy');
    expect(writeText).toHaveBeenCalledWith(CALLBACK);
  });
});

describe('test connection', () => {
  it('shows the result: endpoints, issuer match and the plain-language message', async () => {
    renderForm(CONFIGURED);
    await click('Test connection');
    expect(screen.getByText('Connection OK')).toBeInTheDocument();
    expect(screen.getByText(/Connected\. The provider answered/)).toBeInTheDocument();
    expect(screen.getByText(/Issuer matches: yes/)).toBeInTheDocument();
    expect(screen.getByText(/Authorization endpoint: https:\/\/idp\.example\.test\/authorize/)).toBeInTheDocument();
  });

  it('sends the saved issuer implicitly, and a typed (unsaved) issuer explicitly', async () => {
    renderForm(CONFIGURED);
    await click('Test connection');
    expect(lastBody()).toEqual({});
    type('Issuer URL', 'https://login.example.test/other/v2.0');
    await click('Test connection');
    expect(lastBody()).toEqual({ issuer: 'https://login.example.test/other/v2.0' });
  });

  it('shows a failed result as a failure', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      data: {
        ok: false,
        issuer: 'x',
        callbackUrl: CALLBACK,
        discoveryReachable: false,
        issuerMatches: null,
        authorizationEndpoint: null,
        tokenEndpoint: null,
        jwksUri: null,
        jwksReachable: null,
        message: 'That address is not allowed: private, loopback and link-local network addresses are refused.',
      },
    });
    renderForm(CONFIGURED);
    await click('Test connection');
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
    expect(screen.getByText(/not allowed/)).toBeInTheDocument();
  });

  it('is disabled while there is no issuer', () => {
    renderForm();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  });
});

describe('validation messages (the same shared rules as the server)', () => {
  it('lists every missing field when enabling an empty form, and sends nothing', async () => {
    renderForm();
    fireEvent.click(screen.getByLabelText(/Enable single sign-on/));
    await click('Save single sign-on settings');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Issuer URL must be an absolute URL');
    expect(alert).toHaveTextContent('Client ID is required');
    expect(alert).toHaveTextContent('Client secret is required');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['http://idp.example.test', /must use https/],
    ['https://login.microsoftonline.com/common/v2.0', /multi-tenant/],
    ['https://login.microsoftonline.com/consumers/v2.0', /multi-tenant/],
  ])('refuses the issuer %s', async (issuer, message) => {
    renderForm();
    fireEvent.click(screen.getByLabelText(/Enable single sign-on/));
    type('Issuer URL', issuer);
    type('Client ID', 'c');
    await click('Replace').catch(() => undefined);
    type('Client secret value', NEW_SECRET);
    await click('Save single sign-on settings');
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('refuses a malformed allowed tenant ID', async () => {
    renderForm(CONFIGURED);
    type('Allowed tenant ID', 'contoso');
    await click('Save single sign-on settings');
    expect(screen.getByRole('alert')).toHaveTextContent('Allowed tenant ID must be a tenant id');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows the server message (e.g. the lock-out guard 409) when saving is refused', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false,
      problem: { detail: 'Local login cannot be turned off yet: no active super admin has linked their account.' },
    });
    renderForm(CONFIGURED);
    fireEvent.click(screen.getByLabelText(/Allow password sign-in/));
    await click('Save single sign-on settings');
    expect(screen.getByText(/Local login cannot be turned off yet/)).toBeInTheDocument();
  });
});

describe('Microsoft Entra helper and local-login warning', () => {
  it('turns a tenant ID into the issuer URL and fills the allowed tenant', async () => {
    renderForm();
    const use = screen.getByRole('button', { name: 'Use for Entra' });
    expect(use).toBeDisabled();
    type('Microsoft Entra tenant ID', TENANT);
    await click('Use for Entra');
    expect(screen.getByLabelText('Issuer URL')).toHaveValue(`https://login.microsoftonline.com/${TENANT}/v2.0`);
    expect(screen.getByLabelText('Allowed tenant ID')).toHaveValue(TENANT);
  });

  it('warns when password sign-in is switched off', () => {
    renderForm(CONFIGURED);
    expect(screen.queryByText(/Everyone except super admins/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Allow password sign-in/));
    expect(screen.getByText(/Everyone except super admins/)).toBeInTheDocument();
  });

  it('keeps the assume-MFA option disabled until trust is ticked, and warns when it is on', () => {
    renderForm(CONFIGURED);
    const assume = screen.getByLabelText(/Assume the provider always requires MFA/);
    expect(assume).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/Trust the provider/));
    expect(assume).toBeEnabled();
    expect(screen.queryByText(/Weavestream cannot check it/)).not.toBeInTheDocument();
    fireEvent.click(assume);
    expect(screen.getByText(/Weavestream cannot check it/)).toBeInTheDocument();
  });

  it('sends assumeIdpMfa true only with trust, and clears it when trust is unticked', async () => {
    renderForm(CONFIGURED);
    fireEvent.click(screen.getByLabelText(/Trust the provider/));
    fireEvent.click(screen.getByLabelText(/Assume the provider always requires MFA/));
    await click('Save single sign-on settings');
    expect(lastBody()).toMatchObject({ trustIdpMfa: true, assumeIdpMfa: true });

    fireEvent.click(screen.getByLabelText(/Trust the provider/));
    expect(screen.getByLabelText(/Assume the provider always requires MFA/)).not.toBeChecked();
    await click('Save single sign-on settings');
    expect(lastBody()).toMatchObject({ trustIdpMfa: false, assumeIdpMfa: false });
  });

  it('saves the switches as sent', async () => {
    renderForm(CONFIGURED);
    fireEvent.click(screen.getByLabelText(/Link accounts by email/));
    fireEvent.click(screen.getByLabelText(/Create accounts automatically/));
    fireEvent.click(screen.getByLabelText(/Trust the provider/));
    await click('Save single sign-on settings');
    expect(lastBody()).toMatchObject({ linkByEmail: true, autoProvision: true, trustIdpMfa: true });
  });
});
