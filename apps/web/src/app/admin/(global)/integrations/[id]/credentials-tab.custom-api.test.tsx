/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { TextEncoder } from 'node:util';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../../../components/ui';
import { CredentialsTab } from './credentials-tab';

// jsdom has no TextEncoder; the shared schema uses it for the 64 KiB limit.
Object.assign(globalThis, { TextEncoder });

const apiFetch = jest.fn();
const saveBlob = jest.fn();
const refresh = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: jest.fn() }) }));
jest.mock('../../../../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  saveBlob: (...args: unknown[]) => saveBlob(...args),
}));

const customApi = {
  key: 'custom-api',
  label: 'Custom API',
  configFields: [],
  secretFields: [{ key: 'token', label: 'Token', kind: 'password', required: false }],
  resources: [
    { key: 'items' },
  ],
  capabilities: { kind: 'pull', apiDefinition: true },
} as never;

const definition = {
  version: 1,
  baseUrl: 'https://inventory.example.com/api',
  auth: { method: 'bearer' },
  headers: [],
  organizations: { mode: 'single' },
  resources: {
    items: { enabled: true, request: { method: 'GET', path: '/devices', query: {} }, recordsPath: 'devices', idPath: 'id', namePath: 'name', matchPath: 'serial' },
  },
};

const integration = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'integration-1',
    driver: 'custom-api',
    name: 'Inventory (prod)',
    status: 'PAUSED',
    syncCron: null,
    config: definition,
    hasSecret: true,
    credentialsRequired: true,
    secretMask: { token: '••••1234' },
    resources: [{ enabled: true, assetLayoutId: 'layout', fieldMappingCount: 1 }],
    ...overrides,
  }) as never;

const mappings = [{ enabled: true }] as never;

function renderTab(props: { integration?: never; driver?: never; mappings?: never } = {}) {
  return render(
    <ToastProvider>
      <CredentialsTab integration={props.integration ?? integration()} mappings={props.mappings ?? mappings} driver={props.driver ?? customApi} />
    </ToastProvider>,
  );
}

const patchBody = () => JSON.parse(apiFetch.mock.calls.find(([path, init]) => path === '/admin/integrations/integration-1' && init.method === 'PATCH')[1].body);

describe('CredentialsTab with an API definition (Custom API)', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    saveBlob.mockReset();
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { id: 'integration-1' } });
  });

  it('shows the definition editor in place of the descriptor fields', () => {
    renderTab();
    expect(screen.getByRole('heading', { name: 'API definition' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Configuration' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://inventory.example.com/api');
    expect(screen.getByText('••••1234')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  });

  it('saves a same-host change with the saved secret', async () => {
    renderTab();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://inventory.example.com/v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const body = patchBody();
    expect(body.config.baseUrl).toBe('https://inventory.example.com/v2');
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('clearSecret');
  });

  it('requires the credentials again after a host change', async () => {
    renderTab();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://other.example.com/api' } });
    expect(screen.getAllByText('The host changed. Enter the credentials again for the new host.').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Token *'), { target: { value: 'new-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(patchBody()).toMatchObject({ config: { baseUrl: 'https://other.example.com/api' }, secret: { token: 'new-token' } });
  });

  it('rotates with the full bundle, secret headers included', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByLabelText('Header 1 name'), { target: { value: 'X-Tenant' } });
    fireEvent.click(screen.getByLabelText('Secret'));
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Token *'), { target: { value: 'tok' } });
    fireEvent.change(screen.getByLabelText('Header x-tenant *'), { target: { value: 'tenant-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const body = patchBody();
    expect(body.secret).toEqual({ token: 'tok', 'header:x-tenant': 'tenant-secret' });
    expect(body.config.headers).toEqual([{ name: 'X-Tenant', secret: true }]);
  });

  it('clears the saved secret when the definition switches to no authentication', async () => {
    renderTab();
    fireEvent.click(screen.getByLabelText(/No authentication/));
    expect(screen.getByText(/Saving removes the saved credentials/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(patchBody()).toMatchObject({ config: { auth: { method: 'none' } }, clearSecret: true });
    expect(patchBody()).not.toHaveProperty('secret');
  });

  it('shows the server refusal without echoing a typed secret', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 400, problem: { detail: 'Enter the credentials again for the new host.' } });
    renderTab();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://other.example.com/api' } });
    fireEvent.change(screen.getByLabelText('Token *'), { target: { value: 'new-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findAllByText('Enter the credentials again for the new host.')).not.toHaveLength(0);

    apiFetch.mockResolvedValue({ ok: false, status: 400, problem: { detail: 'rejected new-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findAllByText('Could not save changes.')).not.toHaveLength(0);
    expect(document.body.textContent).not.toContain('rejected new-token');
  });

  it('exports the definition without any secret value', async () => {
    renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }));
    fireEvent.change(screen.getByLabelText('Token *'), { target: { value: 'typed-token-value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export definition' }));
    expect(saveBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = saveBlob.mock.calls[0] as [Blob, string];
    expect(filename).toBe('Inventory _prod_.custom-api.json');
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob);
    });
    expect(JSON.parse(text)).toEqual(definition);
    expect(text).not.toContain('typed-token-value');
    expect(text).not.toContain('1234');
  });

  it('turns off Test connection while the definition has unsaved changes, because it checks the saved one', () => {
    renderTab();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
    fireEvent.click(screen.getByLabelText(/Read items from this API/));
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByText(/Test connection checks the saved definition. Save changes first/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Read items from this API/));
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
    expect(screen.queryByText(/Test connection checks the saved definition/)).not.toBeInTheDocument();
  });

  it('turns Save off after a save, when the stored config comes back with its keys in another order', async () => {
    const view = renderTab();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://inventory.example.com/v2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // router.refresh() gives the tab the stored config; JSONB sorts keys by length.
    const stored = JSON.parse(JSON.stringify(patchBody().config), (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.length - b.length))
        : value,
    );
    view.rerender(
      <ToastProvider>
        <CredentialsTab integration={integration({ config: stored })} mappings={mappings} driver={customApi} />
      </ToastProvider>,
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it('allows a sync without a saved secret when the definition needs none', () => {
    renderTab({ integration: integration({ config: { ...definition, auth: { method: 'none' } }, hasSecret: false, credentialsRequired: false, secretMask: null }) });
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
    expect(screen.queryByText(/Add credentials below/)).not.toBeInTheDocument();
  });
});

describe('CredentialsTab POST body (Custom API)', () => {
  const postDefinition = (body: unknown) => ({
    ...definition,
    resources: {
      ...definition.resources,
      items: { ...definition.resources.items, request: { method: 'POST', path: '/devices/search', query: {}, body } },
    },
  });

  beforeEach(() => {
    apiFetch.mockReset();
    saveBlob.mockReset();
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: { id: 'integration-1' } });
  });

  it('blocks Save, Test and Export while the body is not valid JSON, and saves the fixed body', async () => {
    renderTab({ integration: integration({ config: postDefinition({ all: true }) }) });
    const body = screen.getByLabelText('Body (JSON)');
    fireEvent.change(body, { target: { value: '{ "all": tru' } });
    expect(screen.getByText('This is not valid JSON.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export definition' })).toBeDisabled();
    for (const test of screen.getAllByRole('button', { name: 'Test' })) expect(test).toBeDisabled();

    fireEvent.change(body, { target: { value: '{ "all": false }' } });
    expect(screen.queryByText('This is not valid JSON.')).not.toBeInTheDocument();
    expect(body).toHaveValue('{ "all": false }');
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(patchBody().config.resources.items.request.body).toEqual({ all: false });
  });

  it('shows the imported body when one POST definition replaces another, and keeps it on later edits', async () => {
    renderTab({ integration: integration({ config: postDefinition({ old: 1 }) }) });
    const body = screen.getByLabelText('Body (JSON)');
    expect(body).toHaveValue(JSON.stringify({ old: 1 }, null, 2));
    fireEvent.change(body, { target: { value: '{ "old": ' } });

    fireEvent.click(screen.getByRole('button', { name: 'Import definition' }));
    fireEvent.change(screen.getByLabelText('Or paste the definition'), { target: { value: JSON.stringify(postDefinition({ fresh: 2 })) } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));

    const after = screen.getByLabelText('Body (JSON)');
    expect(after).toHaveValue(JSON.stringify({ fresh: 2 }, null, 2));
    expect(screen.queryByText('This is not valid JSON.')).not.toBeInTheDocument();

    // A later edit elsewhere must not bring the old body back.
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://inventory.example.com/v2' } });
    expect(screen.getByLabelText('Body (JSON)')).toHaveValue(JSON.stringify({ fresh: 2 }, null, 2));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(patchBody().config.resources.items.request.body).toEqual({ fresh: 2 });
  });
});

describe('CredentialsTab credential gate for other drivers', () => {
  const breeze = {
    key: 'breeze',
    configFields: [{ key: 'baseUrl', label: 'Breeze URL', kind: 'url', required: true }],
    secretFields: [{ key: 'apiKey', label: 'Partner API key', kind: 'password', required: true }],
    resources: [],
    capabilities: { kind: 'pull' },
  } as never;

  it('still blocks an API-key driver with no secret', () => {
    renderTab({ driver: breeze, integration: integration({ driver: 'breeze', config: { baseUrl: 'https://b.example' }, hasSecret: false, credentialsRequired: true, secretMask: null }) });
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled();
    expect(screen.getByText('Add credentials below before running a sync.')).toBeInTheDocument();
  });

  it('keeps the OAuth connection text', () => {
    const oauth = { ...(breeze as object), configFields: [], secretFields: [], oauth: { provider: 'google', scopes: [] } } as never;
    renderTab({ driver: oauth, integration: integration({ driver: 'google-workspace', config: {}, hasSecret: false, credentialsRequired: true, secretMask: null }) });
    expect(screen.getByText('Connect a client tenant on the Connections tab before running a sync.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run sync now' })).toBeDisabled();
  });
});
