/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { TextEncoder } from 'node:util';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '../../../../components/ui';
import { CreateIntegrationButton } from './create-integration-button';

// jsdom has no TextEncoder; the shared schema uses it for the 64 KiB limit.
Object.assign(globalThis, { TextEncoder });

const apiFetch = jest.fn();
const push = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: jest.fn() }) }));
jest.mock('../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const customApi = {
  key: 'custom-api',
  label: 'Custom API',
  description: 'Connect any JSON API that has no built-in integration.',
  iconKey: 'custom-api',
  configFields: [],
  secretFields: [{ key: 'token', label: 'Token', kind: 'password', required: false }],
  resources: [],
  capabilities: { kind: 'pull', apiDefinition: true },
} as never;

const imported = {
  version: 1,
  baseUrl: 'https://inventory.example.com',
  auth: { method: 'bearer' },
  headers: [{ name: 'X-Tenant', secret: true }],
  organizations: {
    mode: 'endpoint',
    request: { path: '/groups' },
    idPath: 'id',
    namePath: 'name',
  },
  resources: {
    devices: { enabled: true, request: { path: '/groups/{orgId}/devices' }, idPath: 'id', namePath: 'name', matchPath: 'serial' },
  },
};

function open() {
  render(
    <ToastProvider>
      <CreateIntegrationButton drivers={[customApi]} />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'New integration' }));
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Inventory' } });
}

const postBody = () => JSON.parse(apiFetch.mock.calls.find(([path]) => path === '/admin/integrations')[1].body);

function importDefinition(definition: unknown) {
  fireEvent.click(screen.getByRole('button', { name: 'Import definition…' }));
  fireEvent.change(screen.getByLabelText('Or paste the definition'), { target: { value: JSON.stringify(definition) } });
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
}

describe('CreateIntegrationButton with Custom API', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    push.mockReset();
  });

  it('creates from Base URL and authentication alone, with the starting definition and exactly the token', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 201, data: { id: 'integration-1' } });
    open();
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    const create = screen.getByRole('button', { name: 'Create integration' });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://inventory.example.com/api' } });
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Token *'), { target: { value: 'tok' } });
    expect(create).toBeEnabled();
    fireEvent.click(create);

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(postBody()).toEqual({
      driver: 'custom-api',
      name: 'Inventory',
      config: {
        version: 1,
        baseUrl: 'https://inventory.example.com/api',
        auth: { method: 'bearer' },
        headers: [],
        organizations: { mode: 'single' },
        resources: { devices: { enabled: false }, other_assets: { enabled: false } },
      },
      secret: { token: 'tok' },
      status: 'PAUSED',
    });
    expect(push).toHaveBeenCalledWith('/admin/integrations/integration-1');
  });

  it('sends no secret for a definition with no authentication', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 201, data: { id: 'integration-1' } });
    open();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://inventory.example.com' } });
    fireEvent.click(screen.getByLabelText(/No authentication/));
    fireEvent.click(screen.getByRole('button', { name: 'Create integration' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(postBody()).not.toHaveProperty('secret');
    expect(postBody().config.auth).toEqual({ method: 'none' });
  });

  it('tests an imported definition through the draft route with the typed secrets, then creates it whole', async () => {
    open();
    importDefinition(imported);
    expect(screen.getByText('Definition imported')).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://inventory.example.com');
    const test = screen.getByRole('button', { name: 'Test' });
    expect(test).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Token *'), { target: { value: 'tok' } });
    fireEvent.change(screen.getByLabelText('Header x-tenant *'), { target: { value: 'tenant' } });
    apiFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { ok: true, section: 'organizations', recordCount: 1, hasMore: false, records: [{ id: 'g1', name: 'Acme', match: null, fields: [] }], keys: [], correlationId: 'c' },
    });
    fireEvent.click(test);
    await screen.findByText('1 organization on the first page. More pages: no.');
    expect(apiFetch.mock.calls[0][0]).toBe('/admin/integrations/custom-api/draft-test');
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toMatchObject({
      section: 'organizations',
      secret: { token: 'tok', 'header:x-tenant': 'tenant' },
    });

    apiFetch.mockResolvedValue({ ok: true, status: 201, data: { id: 'integration-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create integration' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/admin/integrations/integration-2'));
    expect(postBody()).toMatchObject({ config: imported, secret: { token: 'tok', 'header:x-tenant': 'tenant' } });
  });

  it('removes an import and goes back to the starting definition', () => {
    open();
    importDefinition(imported);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Header x-tenant *')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toHaveValue('https://inventory.example.com');
  });
});
