/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DriverOAuthDescriptor, IntegrationConnection } from '@weavestream/shared';
import { ToastProvider } from '../../../../../components/ui';
import { ConnectionsTab } from './connections-tab';

const apiFetch = jest.fn();
const refresh = jest.fn();
const replace = jest.fn();
let search = new URLSearchParams();
let mobile = false;

jest.mock('../../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('../../../../../lib/hooks/use-is-mobile', () => ({ useIsMobile: () => mobile }));
jest.mock('next/navigation', () => ({
  useRouter: () => ({ refresh, replace }),
  usePathname: () => '/admin/integrations/int-1',
  useSearchParams: () => search,
}));

const oauth: DriverOAuthDescriptor = {
  provider: 'google',
  authorizeUrl: 'https://auth.example.test/authorize',
  tokenUrl: 'https://auth.example.test/token',
  scopes: ['scope.read'],
};

const CONN_A = '00000000-0000-4000-8000-0000000000a1';

function conn(over: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: CONN_A,
    externalOrgId: 'C0example1',
    displayName: 'example.com',
    connectedAs: 'admin@example.test',
    connectedAt: '2026-01-05T12:00:00Z',
    grantedScopes: ['scope.read'],
    status: 'ok',
    lastErrorAt: null,
    lastSyncAt: null,
    reportNames: null,
    ...over,
  };
}

function list(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    data: {
      provider: 'google',
      appConfigured: true,
      redirectUri: 'https://ws.example.test/cb',
      appSecretExpiryWarning: null,
      appSecretExpired: false,
      connections: [],
      ...over,
    },
  };
}

async function renderIt(props: Partial<Parameters<typeof ConnectionsTab>[0]> = {}) {
  await act(async () => {
    render(
      <ToastProvider>
        <ConnectionsTab integrationId="int-1" oauth={oauth} {...props} />
      </ToastProvider>,
    );
  });
}

beforeEach(() => {
  apiFetch.mockReset();
  refresh.mockReset();
  replace.mockReset();
  search = new URLSearchParams();
  mobile = false;
});

describe('ConnectionsTab', () => {
  it('connects a new client tenant without a connection id and sends the browser to the provider', async () => {
    const open = jest.spyOn(window, 'open').mockReturnValue(null);
    apiFetch
      .mockResolvedValueOnce(list())
      .mockResolvedValueOnce({ ok: true, status: 200, data: { authorizeUrl: 'https://auth.example.test/authorize?x=1' } });
    await renderIt();
    expect(screen.getByText(/No client tenants yet/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Connect a client/ }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/integrations/int-1/connections/start', { method: 'POST', body: '{}' });
    expect(open).toHaveBeenCalledWith('https://auth.example.test/authorize?x=1', '_self');
  });

  it('lists one row per tenant and binds Reconnect to that connection', async () => {
    jest.spyOn(window, 'open').mockReturnValue(null);
    apiFetch
      .mockResolvedValueOnce(list({ connections: [conn(), conn({ id: 'b', externalOrgId: 'C0example2', displayName: 'example.org', status: 'needs_reconnect' })] }))
      .mockResolvedValueOnce({ ok: true, status: 200, data: { authorizeUrl: 'https://auth.example.test/authorize' } });
    await renderIt();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.getAllByText('admin@example.test')).toHaveLength(2);
    expect(screen.getByText('needs reconnect')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect example.com' }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/integrations/int-1/connections/start', {
      method: 'POST',
      body: JSON.stringify({ connectionId: CONN_A }),
    });
  });

  it('shows app secret expired as the status of every connection', async () => {
    apiFetch.mockResolvedValueOnce(list({ connections: [conn()], appSecretExpired: true, appSecretExpiryWarning: 'The client secret expired on 2026-10-01.' }));
    await renderIt();
    expect(screen.getByText('app secret expired')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('expired on 2026-10-01');
  });

  it('disables connecting and links to the App tab when the app is missing', async () => {
    apiFetch.mockResolvedValueOnce(list({ appConfigured: false }));
    await renderIt();
    expect(screen.getByRole('button', { name: /Connect a client/ })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Set it up on the App tab' })).toHaveAttribute('href', '/admin/integrations/int-1?tab=app');
  });

  it('disconnects one connection after confirmation', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    apiFetch
      .mockResolvedValueOnce(list({ connections: [conn()] }))
      .mockResolvedValueOnce({ ok: true, status: 204, data: null })
      .mockResolvedValueOnce(list());
    await renderIt();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect example.com' }));
    });
    expect(apiFetch).toHaveBeenCalledWith(`/admin/integrations/int-1/connections/${CONN_A}/disconnect`, { method: 'POST', body: '{}' });
    await waitFor(() => expect(screen.getByText(/No client tenants yet/)).toBeInTheDocument());
    expect(refresh).toHaveBeenCalled();
  });

  it('runs Check setup for the selected connection', async () => {
    apiFetch
      .mockResolvedValueOnce(list({ connections: [conn()] }))
      .mockResolvedValueOnce({ ok: true, status: 200, data: { ok: true, passedStepIds: ['connect'], failures: [] } });
    await renderIt({ setupGuide: [{ id: 'connect', title: 'Connect a customer', body: 'Sign in.' }] });
    fireEvent.click(screen.getByText('example.com'));
    fireEvent.click(screen.getByRole('button', { name: /Setup guide/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check setup/ }));
    });
    expect(apiFetch).toHaveBeenLastCalledWith(`/admin/integrations/int-1/check?connectionId=${CONN_A}`, { method: 'POST', body: '{}' });
    expect(screen.getByText('Setup check passed.')).toBeInTheDocument();
  });

  it('shows the load failure when the list request throws', async () => {
    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await renderIt();
    expect(screen.getByText(/Could not load the connections/)).toBeInTheDocument();
  });

  it('re-enables the row buttons and reports an error when a request throws', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    apiFetch
      .mockResolvedValueOnce(list({ connections: [conn()] }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await renderIt();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect example.com' }));
    });
    expect(screen.getByText('Could not disconnect.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect example.com' })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect example.com' }));
    });
    expect(screen.getByText(/Could not start the .* sign-in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect example.com' })).toBeEnabled();
  });

  it('stops the setup check spinner when the request throws', async () => {
    apiFetch
      .mockResolvedValueOnce(list({ connections: [conn()] }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await renderIt({ setupGuide: [{ id: 'connect', title: 'Connect a customer', body: 'Sign in.' }] });
    fireEvent.click(screen.getByText('example.com'));
    fireEvent.click(screen.getByRole('button', { name: /Setup guide/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Check setup/ }));
    });
    expect(screen.getByText('Could not run the setup check.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check setup/ })).toBeEnabled();
  });

  it('renders cards on a phone', async () => {
    mobile = true;
    apiFetch.mockResolvedValueOnce(list({ connections: [conn()] }));
    await renderIt();
    expect(screen.getByText('Tenant')).toBeInTheDocument();
    expect(screen.getByText('C0example1')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect example.com' })).toBeInTheDocument();
  });

  it.each([
    ['connected', 'Connected with Google.'],
    ['failed', /Could not connect with Google/],
  ])('turns ?oauth=%s into a toast and strips the flag', async (flag, message) => {
    search = new URLSearchParams({ oauth: flag, tab: 'connections' });
    apiFetch.mockResolvedValueOnce(list());
    await renderIt();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith('/admin/integrations/int-1?tab=connections');
  });

  it('turns the reconnect reasons into fixed text', async () => {
    search = new URLSearchParams('oauth=failed&reason=wrong_tenant');
    apiFetch.mockResolvedValueOnce(list());
    await renderIt();
    expect(screen.getByText(/signed in to a different tenant/)).toBeInTheDocument();
  });

  it('ignores an unknown reason value and inherited keys (generic text, nothing echoed)', async () => {
    for (const reason of ['<b>evil</b>', 'constructor']) {
      search = new URLSearchParams({ oauth: 'failed', reason });
      apiFetch.mockResolvedValueOnce(list());
      const view = await (async () => {
        let r: ReturnType<typeof render> | undefined;
        await act(async () => {
          r = render(
            <ToastProvider>
              <ConnectionsTab integrationId="int-1" oauth={oauth} />
            </ToastProvider>,
          );
        });
        return r!;
      })();
      expect(screen.getByText(/Could not connect with Google/)).toBeInTheDocument();
      expect(screen.queryByText(/evil/)).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it('ignores any other flag value', async () => {
    search = new URLSearchParams({ oauth: '<b>provider text</b>' });
    apiFetch.mockResolvedValueOnce(list());
    await renderIt();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('ConnectionsTab (Microsoft admin consent)', () => {
  const msOauth: DriverOAuthDescriptor = {
    provider: 'microsoft',
    consentFlow: 'admin_consent',
    authorizeUrl: 'https://login.microsoftonline.com/organizations/v2.0/adminconsent',
    tokenUrl: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
    clientCredentialsScope: 'https://graph.microsoft.com/.default',
    scopes: ['User.Read.All'],
  };
  const reportNames = { ok: true, status: 200, data: { concealed: true, choice: null, readError: null, canChange: true } };

  it('says who must approve, shows granted permissions, and asks the report-names choice per connection', async () => {
    apiFetch.mockImplementation(async (url: string) =>
      url.endsWith('/microsoft/report-names')
        ? reportNames
        : list({ provider: 'microsoft', connections: [conn({ externalOrgId: '11111111-2222-4333-8444-555555555555', displayName: 'Example Tenant', connectedAs: null, grantedScopes: ['User.Read.All'] })] }),
    );
    await renderIt({ oauth: msOauth });
    expect(screen.getByText(/Global Administrator or Privileged Role Administrator/)).toBeInTheDocument();
    expect(screen.getByText('1 granted')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Example Tenant'));
    await waitFor(() => expect(screen.getByLabelText('Usage report names')).toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledWith(`/admin/integrations/int-1/connections/${CONN_A}/microsoft/report-names`);
  });

  it('turns a failure reason into fixed text and strips it from the URL', async () => {
    search = new URLSearchParams('oauth=failed&reason=admin_required');
    apiFetch.mockResolvedValueOnce(list({ provider: 'microsoft' }));
    await renderIt({ oauth: msOauth });
    expect(screen.getByText(/must approve\. Sign in/)).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith('/admin/integrations/int-1');
  });
});
