/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { TextEncoder } from 'node:util';
import { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CustomApiTestResponse } from '@weavestream/shared';
import { DefinitionEditor } from './definition-editor';
import { emptyResource, issuesOf, newDefinition, type CustomApiDraft } from './definition-draft';
import { TestPanel } from './test-panel';

// jsdom has no TextEncoder; the shared schema uses it for the 64 KiB limit.
Object.assign(globalThis, { TextEncoder });

const apiFetch = jest.fn();
let mobile = false;

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));

jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../../lib/hooks/use-is-mobile', () => ({ useIsMobile: () => mobile }));

const devicesOk: CustomApiTestResponse = {
  ok: true,
  section: 'items',
  recordCount: 12,
  hasMore: true,
  records: [
    {
      id: 'd-1',
      name: 'PC-01',
      match: 'SN-1',
      fields: [
        { key: 'hostname', label: 'Hostname', path: 'host', value: 'pc-01', masked: false, warning: null },
        { key: 'model', label: 'Model', path: 'model', value: null, masked: false, warning: 'missing' },
      ],
    },
  ],
  keys: [
    { path: 'system.serial', type: 'string', sample: 'SN-1', masked: false },
    { path: 'apiToken', type: 'string', sample: '••••', masked: true },
  ],
  correlationId: 'corr-1',
};

const orgsOk: CustomApiTestResponse = {
  ok: true,
  section: 'organizations',
  recordCount: 2,
  hasMore: false,
  records: [
    { id: 'org-1', name: 'Acme', match: null, fields: [] },
    { id: '••••', name: 'Hidden', match: null, fields: [] },
  ],
  keys: [{ path: 'id', type: 'string', sample: 'org-1', masked: false }],
  correlationId: 'corr-2',
};

function endpointDraft(): CustomApiDraft {
  return {
    ...newDefinition('https://inventory.example.com/api', { method: 'bearer' }),
    organizations: {
      mode: 'endpoint',
      request: { method: 'GET', path: '/groups', query: {} },
      recordsPath: 'groups',
      idPath: 'id',
      namePath: 'name',
      pagination: { style: 'none' },
    },
    resources: {
      items: {
        ...emptyResource(),
        request: { method: 'GET', path: '/groups/{orgId}/devices', query: {} },
        idPath: 'id',
        namePath: 'name',
        matchPath: 'serial',
      },
    },
  };
}

function Harness({ initial, testSecret }: { initial: CustomApiDraft; testSecret?: Record<string, string> }) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <DefinitionEditor
        value={draft}
        onChange={setDraft}
        issues={issuesOf(draft)}
        integrationId="integration-1"
        testSecret={testSecret}
        credentials={<div>credentials slot</div>}
      />
      <output data-testid="draft">{JSON.stringify(draft)}</output>
    </>
  );
}

const draftOf = () => JSON.parse(screen.getByTestId('draft').textContent ?? '{}') as CustomApiDraft;

describe('DefinitionEditor', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    mobile = false;
  });

  it('renders the sections in order, with the credentials after Headers', () => {
    render(<Harness initial={endpointDraft()} />);
    const headings = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
    expect(headings).toEqual(['Connection', 'Authentication', 'Headers', 'Organizations', 'Items']);
    expect(screen.getByText('credentials slot')).toBeInTheDocument();
  });

  it('shows the fields of the picked authentication method and its issues under the input', () => {
    render(<Harness initial={endpointDraft()} />);
    fireEvent.click(screen.getByLabelText(/OAuth client credentials/));
    const tokenUrl = screen.getByLabelText('Token URL');
    fireEvent.change(tokenUrl, { target: { value: 'http://login.example.net/token' } });
    expect(screen.getByText('Token URL must start with https://.')).toBeInTheDocument();
    expect(draftOf().auth).toMatchObject({ method: 'oauth_client_credentials', tokenUrl: 'http://login.example.net/token' });
    fireEvent.click(screen.getByLabelText(/API key header/));
    expect(screen.queryByLabelText('Token URL')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Header name')).toBeInTheDocument();
  });

  it('keeps 2 query parameters with the same name as rows, in order, and blocks the definition', () => {
    render(<Harness initial={endpointDraft()} />);
    const devices = within(screen.getByRole('heading', { name: 'Items' }).closest('section')!);
    const add = () => fireEvent.click(devices.getByRole('button', { name: 'Add query parameter' }));
    const set = (label: string, value: string) => fireEvent.change(devices.getByLabelText(label), { target: { value } });
    add();
    set('Query parameter 1 name', 'page');
    set('Query parameter 1 value', '{page}');
    add();
    set('Query parameter 2 name', 'page');
    set('Query parameter 2 value', '2');
    expect(devices.getByLabelText('Query parameter 1 value')).toHaveValue('{page}');
    expect(devices.getByLabelText('Query parameter 2 value')).toHaveValue('2');
    expect(devices.getByText('Two query parameters have the same name. Change one of them.')).toBeInTheDocument();
    expect(devices.getByRole('button', { name: 'Test' })).toBeDisabled();
    // A name that is a number keeps its row in place.
    set('Query parameter 2 name', '1');
    expect(devices.getByLabelText('Query parameter 1 name')).toHaveValue('page');
    expect(devices.getByLabelText('Query parameter 2 name')).toHaveValue('1');
    expect(devices.queryByText(/same name/)).not.toBeInTheDocument();
    expect(draftOf().resources.items).toMatchObject({ request: { query: { page: '{page}', 1: '2' } } });
  });

  it('keeps a turned-off resource’s paths for when it is turned on again', () => {
    render(<Harness initial={endpointDraft()} />);
    fireEvent.click(screen.getByLabelText(/Read items from this API/));
    expect(draftOf().resources.items).toEqual({ enabled: false });
    fireEvent.click(screen.getByLabelText(/Read items from this API/));
    expect(draftOf().resources.items).toMatchObject({ enabled: true, matchPath: 'serial' });
  });

  it('marks a secret header and never keeps its value in the definition', () => {
    render(<Harness initial={endpointDraft()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add header' }));
    fireEvent.change(screen.getByLabelText('Header 1 name'), { target: { value: 'X-Tenant' } });
    fireEvent.change(screen.getByLabelText('Header 1 value'), { target: { value: 'plain' } });
    fireEvent.click(screen.getByLabelText('Secret'));
    expect(draftOf().headers).toEqual([{ name: 'X-Tenant', secret: true }]);
    expect(screen.queryByLabelText('Header 1 value')).not.toBeInTheDocument();
  });

  it('tests a resource in endpoint mode with a picked or typed organization id', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: orgsOk }).mockResolvedValue({ ok: true, status: 200, data: devicesOk });
    render(<Harness initial={endpointDraft()} />);
    const devices = screen.getByRole('region', { name: 'Items' });
    expect(within(devices).getByRole('button', { name: 'Test' })).toBeDisabled();
    expect(within(devices).getByText('Pick or type an organization id to test with.')).toBeInTheDocument();

    // Organizations first: its ids fill the picker; a masked id is not offered.
    fireEvent.click(within(screen.getByRole('region', { name: 'Organizations' })).getByRole('button', { name: 'Test' }));
    await screen.findByText('2 organizations on the first page. More pages: no.');
    const picker = within(devices).getByLabelText('Test with organization');
    expect(within(picker).queryByRole('option', { name: /Hidden/ })).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'org-1' } });
    fireEvent.click(within(devices).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1][0]).toBe('/admin/integrations/integration-1/custom-api/test');
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toMatchObject({ section: 'items', orgId: 'org-1' });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).not.toHaveProperty('secret');

    // A typed id works too (a sample may be masked or cut).
    fireEvent.change(within(devices).getByLabelText('Organization id'), { target: { value: 'typed-7' } });
    fireEvent.click(within(devices).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(apiFetch.mock.calls[2][1].body)).toMatchObject({ orgId: 'typed-7' });
  });

  it('sends no organization id outside endpoint mode, and the typed bundle when given', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: devicesOk });
    const draft = { ...endpointDraft(), organizations: { mode: 'single' as const } };
    (draft.resources.items as { request: { path: string } }).request.path = '/devices';
    render(<Harness initial={draft} testSecret={{ token: 'typed' }} />);
    const devices = screen.getByRole('region', { name: 'Items' });
    expect(within(devices).queryByLabelText('Organization id')).not.toBeInTheDocument();
    fireEvent.click(within(devices).getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('orgId');
    expect(body.secret).toEqual({ token: 'typed' });
  });

  it('puts a clicked key into the last path input the admin selected, and shows samples', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: devicesOk });
    const draft = { ...endpointDraft(), organizations: { mode: 'single' as const } };
    (draft.resources.items as { request: { path: string } }).request.path = '/devices';
    render(<Harness initial={draft} />);
    const devices = screen.getByRole('region', { name: 'Items' });
    fireEvent.click(within(devices).getByRole('button', { name: 'Test' }));
    await screen.findByText('12 records on the first page. More pages: yes.');
    expect(screen.getAllByText('no value').length).toBeGreaterThan(0);

    fireEvent.focus(within(devices).getByLabelText('Match value path (optional)'));
    fireEvent.click(screen.getByRole('button', { name: /system\.serial/ }));
    expect(draftOf().resources.items).toMatchObject({ matchPath: 'system.serial' });
    expect(within(devices).getByText('First record: SN-1')).toBeInTheDocument();
    // A masked key shows the mask, never a value.
    expect(screen.getByRole('button', { name: /apiToken/ })).toHaveTextContent('••••');
  });

  it('refuses to test an invalid definition', () => {
    render(<Harness initial={{ ...endpointDraft(), baseUrl: 'http://plain.example' }} />);
    expect(within(screen.getByRole('region', { name: 'Organizations' })).getByRole('button', { name: 'Test' })).toBeDisabled();
  });
});

describe('TestPanel', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    mobile = false;
  });

  const panel = (props: Partial<React.ComponentProps<typeof TestPanel>> = {}) =>
    render(
      <TestPanel
        integrationId={null}
        definition={newDefinition('https://inventory.example.com', { method: 'bearer' })}
        section="organizations"
        disabledReason={null}
        {...props}
      />,
    );

  it('uses the draft route without an integration id', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: orgsOk });
    panel({ secret: { token: 'typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/custom-api/draft-test', expect.anything()));
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toMatchObject({ section: 'organizations', secret: { token: 'typed' } });
  });

  it('shows the fixed failure text, the status and the reference', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: false, section: 'organizations', message: 'The API refused the credentials', status: 401, correlationId: 'corr-9' },
    });
    panel();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('The API refused the credentials (401)')).toBeInTheDocument();
    expect(screen.getByText('Reference: corr-9')).toBeInTheDocument();
  });

  it('explains the rate limit, and never shows a typed secret in a refusal', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, status: 429, problem: { detail: 'Too Many Requests' } });
    panel({ secret: { token: 'typed-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Too many tests. Wait a minute, then test again.')).toBeInTheDocument();

    apiFetch.mockResolvedValueOnce({ ok: false, status: 400, problem: { detail: 'rejected typed-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('The test failed. Try again.')).toBeInTheDocument();
  });

  it('recovers from a network failure: shows fixed text, clears the old result, and can retry', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: orgsOk });
    panel();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('2 organizations on the first page. More pages: no.');

    apiFetch.mockRejectedValueOnce(new TypeError('Failed to fetch https://internal.example/secret'));
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Could not reach Weavestream. Check the connection, then test again.')).toBeInTheDocument();
    expect(screen.queryByText(/organizations on the first page/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('internal.example');
    expect(screen.getByRole('button', { name: 'Test' })).toBeEnabled();

    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, data: orgsOk });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('2 organizations on the first page. More pages: no.');
    expect(screen.queryByText(/Could not reach Weavestream/)).not.toBeInTheDocument();
  });

  it('renders records as cards at phone width', async () => {
    mobile = true;
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: devicesOk });
    panel({ section: 'items', secret: undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('12 records on the first page. More pages: yes.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('PC-01')).toBeInTheDocument();
    expect(screen.getByText('pc-01')).toBeInTheDocument();
  });
});
