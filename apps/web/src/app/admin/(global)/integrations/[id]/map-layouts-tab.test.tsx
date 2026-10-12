/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MapLayoutsTab, matchableResources, suggestField, suggestLayout, suggestStandardField } from './map-layouts-tab';

const apiFetch = jest.fn();
const toastPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../../components/ui', () => ({
  Btn: ({ children, loading, kind: _kind, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => <button aria-busy={Boolean(loading)} {...props}>{children}</button>,
  Field: ({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) => (
    <div><label htmlFor={htmlFor}>{label}</label>{children}</div>
  ),
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => ({ push: toastPush }),
  DataTable: ({ columns, rows }: { columns: Array<{ id: string; render: (row: unknown) => React.ReactNode }>; rows: Array<{ id: string }> }) => (
    <table><tbody>{rows.map((r) => <tr key={r.id}>{columns.map((c) => <td key={c.id}>{c.render(r)}</td>)}</tr>)}</tbody></table>
  ),
  MobileCardRow: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const field = (id: string, name: string, slug: string) => ({
  id, name, slug, fieldType: 'TEXT', position: 0, isRequired: false, isUniquePerCompany: false,
  visibleToClients: true, isPrimary: false, showInTable: true, options: {}, archivedAt: null,
});
const layout = (id: string, name: string, slug: string, fields: ReturnType<typeof field>[]) => ({
  id, name, slug, icon: 'x', color: 'x', isActive: true, version: 1, position: 0, archivedAt: null,
  createdBy: null, createdAt: '', updatedAt: '', fields,
});

const people = layout('l-people', 'People', 'people', [field('f-name', 'Name', 'name'), field('f-email', 'Email address', 'email_address')]);
const laptops = layout('l-laptops', 'Laptops', 'laptops', [field('f-serial', 'Serial', 'serial')]);

const users = {
  key: 'users', label: 'Users', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
  matchSuggestions: { sourceField: 'primaryEmail', layoutHints: ['people', 'contacts'], fieldHints: ['email', 'e-mail'] },
};
const groups = {
  key: 'groups', label: 'Groups', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
  matchSuggestions: { sourceField: 'email', layoutHints: ['distribution lists'], fieldHints: ['email'] },
};
const driver = { resources: [users, groups, { key: 'other', label: 'Other', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [] }] };

const row = (resourceKey: string, overrides: Record<string, unknown> = {}) => ({
  id: `r-${resourceKey}`, integrationId: 'i1', resourceKey, resourceLabel: resourceKey, enabled: true,
  targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [], assetLayoutId: null, assetLayoutName: null,
  matchKeyFieldIds: [], fieldMappingCount: 0, createdAt: '', updatedAt: '', ...overrides,
});

describe('layout matcher suggestions', () => {
  it('lists only resources that declare matchSuggestions', () => {
    expect(matchableResources(driver as never).map((r) => r.key)).toEqual(['users', 'groups']);
    expect(matchableResources(null)).toEqual([]);
  });

  it('prefers exact hint matches over partial ones, in hint order', () => {
    const contacts = layout('l-c', 'Contacts', 'contacts', []);
    const peopleOld = layout('l-po', 'People (old)', 'people_old', []);
    expect(suggestLayout([peopleOld, contacts, people] as never, ['people', 'contacts'])?.id).toBe('l-people');
    expect(suggestLayout([peopleOld, contacts] as never, ['people', 'contacts'])?.id).toBe('l-c');
    expect(suggestLayout([laptops] as never, ['people'])).toBeNull();
    expect(suggestField(people.fields as never, ['email'])?.id).toBe('f-email');
  });
});

describe('MapLayoutsTab', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toastPush.mockReset();
  });

  it('pre-selects suggested layouts and match fields, creates a new layout when none fits, and saves', async () => {
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/layouts') return { ok: true, data: { items: [people, laptops] } };
      if (path.endsWith('/field-mappings') && !init) return { ok: true, data: [] };
      return { ok: true, data: row('users') };
    });
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('users'), row('groups')] } as never} driver={driver as never} />);

    const usersLayout = await screen.findByLabelText('Layout', { selector: '#map-layout-users' });
    expect(usersLayout).toHaveValue('l-people');
    expect(screen.getByLabelText('Match primaryEmail on')).toHaveValue('f-email');
    // No "distribution lists" layout: groups default to creating one.
    expect(screen.getByLabelText('Layout', { selector: '#map-layout-groups' })).toHaveValue('__new__');

    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/admin/integrations/i1/resources/groups/destination', { method: 'POST' },
    ));
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/users', {
      method: 'PATCH',
      body: JSON.stringify({ assetLayoutId: 'l-people', matchKeyFieldIds: ['f-email'], enabled: true }),
    });
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/users/field-mappings', {
      method: 'PATCH',
      body: JSON.stringify({ mappings: [{ sourceField: 'primaryEmail', targetFieldId: 'f-email', syncDirection: 'source_wins', transform: null }] }),
    });
  });

  it('disables a skipped resource instead of failing, and leaves unchanged ones alone', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/layouts' ? { ok: true, data: { items: [people] } } : { ok: true, data: row('users') },
    );
    render(
      <MapLayoutsTab
        integration={{ id: 'i1', resources: [
          row('users', { assetLayoutId: 'l-people', matchKeyFieldIds: ['f-email'], fieldMappingCount: 1 }),
          row('groups'),
        ] } as never}
        driver={driver as never}
      />,
    );
    const groupsLayout = await screen.findByLabelText('Layout', { selector: '#map-layout-groups' });
    fireEvent.change(groupsLayout, { target: { value: '__skip__' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/groups', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    }));
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining('/resources/users'), expect.anything());
  });

  it('requires a match field before saving an existing layout', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/layouts' ? { ok: true, data: { items: [people, laptops] } } : { ok: true, data: row('users') },
    );
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('users', { enabled: false })] } as never} driver={{ resources: [users] } as never} />);
    const select = await screen.findByLabelText('Layout', { selector: '#map-layout-users' });
    fireEvent.change(select, { target: { value: 'l-laptops' } });
    fireEvent.change(screen.getByLabelText('Match primaryEmail on'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    expect(await screen.findByText('Pick the field to match on.')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('offers to create the match field when the layout has none, then maps the created field', async () => {
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === '/layouts') return { ok: true, data: { items: [people, laptops] } };
      if (path.endsWith('/match-field')) return { ok: true, data: { fieldId: 'f-created', created: true } };
      if (path.endsWith('/field-mappings') && !init) return { ok: true, data: [] };
      return { ok: true, data: row('users') };
    });
    const labelled = { ...users, matchSuggestions: { ...users.matchSuggestions, fieldLabel: 'Email' } };
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('users', { enabled: false })] } as never} driver={{ resources: [labelled] } as never} />);
    fireEvent.change(await screen.findByLabelText('Layout', { selector: '#map-layout-users' }), { target: { value: 'l-laptops' } });
    const match = screen.getByLabelText('Match primaryEmail on');
    // No field fits the hints: "Create field" is pre-selected.
    expect(match).toHaveValue('__create_field__');
    expect(screen.getByRole('option', { name: 'Create field "Email"' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/users/field-mappings', {
      method: 'PATCH',
      body: JSON.stringify({ mappings: [{ sourceField: 'primaryEmail', targetFieldId: 'f-created', syncDirection: 'source_wins', transform: null }] }),
    }));
    const paths = apiFetch.mock.calls.map(([path]) => path);
    expect(paths.indexOf('/admin/integrations/i1/resources/users/match-field')).toBeLessThan(paths.indexOf('/admin/integrations/i1/resources/users'));
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/users/match-field', {
      method: 'POST', body: JSON.stringify({ assetLayoutId: 'l-laptops' }),
    });
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/users', {
      method: 'PATCH',
      body: JSON.stringify({ assetLayoutId: 'l-laptops', matchKeyFieldIds: ['f-created'], enabled: true }),
    });
  });

  it('keeps an existing field pre-selected when one matches the hints', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/layouts' ? { ok: true, data: { items: [people] } } : { ok: true, data: row('users') },
    );
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('users')] } as never} driver={{ resources: [users] } as never} />);
    const match = await screen.findByLabelText('Match primaryEmail on');
    expect(match).toHaveValue('f-email');
    expect(screen.getByRole('option', { name: 'Create field "Primary email"' })).toBeInTheDocument();
  });

  it('resets pending and toasts when the match-field request rejects', async () => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === '/layouts') return { ok: true, data: { items: [laptops] } };
      if (path.endsWith('/match-field')) throw new TypeError('Failed to fetch');
      return { ok: true, data: row('users') };
    });
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('users')] } as never} driver={{ resources: [users] } as never} />);
    fireEvent.change(await screen.findByLabelText('Layout'), { target: { value: 'l-laptops' } });
    const button = screen.getByRole('button', { name: 'Save layout mapping' });
    fireEvent.click(button);
    await waitFor(() => expect(toastPush).toHaveBeenCalledWith(expect.stringMatching(/Could not save/), 'danger'));
    expect(button).toHaveAttribute('aria-busy', 'false');
  });

  it('disables Create new layout and Create field without the layout permission', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/layouts' ? { ok: true, data: { items: [laptops] } } : { ok: true, data: row('users') },
    );
    render(
      <MapLayoutsTab
        integration={{ id: 'i1', resources: [row('users')] } as never}
        driver={{ resources: [users] } as never}
        canManageLayouts={false}
      />,
    );
    // No layout fits the hints: it falls back to Skip instead of a disabled Create new layout.
    expect(await screen.findByLabelText('Layout')).toHaveValue('__skip__');
    expect(screen.getByRole('option', { name: 'Create new layout' })).toBeDisabled();
    expect(screen.getByText(/need permission to manage asset layouts/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Layout'), { target: { value: 'l-laptops' } });
    expect(screen.getByLabelText('Match primaryEmail on')).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Create field "Primary email"' })).toBeDisabled();
  });
});

describe('Map layouts standard fields', () => {
  const typed = (id: string, name: string, slug: string, fieldType: string) => ({ ...field(id, name, slug), fieldType });
  const workstations = layout('l-ws', 'Workstations', 'workstations', [
    field('f-serial', 'Serial number', 'serial_number'),
    field('f-host', 'Host name', 'host_name'),
    typed('f-ip', 'IP address', 'ip_address', 'IP_ADDRESS'),
    typed('f-os', 'Operating system', 'os_choice', 'DROPDOWN'),
  ]);
  const devices = {
    key: 'devices', label: 'Devices', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [],
    matchSuggestions: { sourceField: 'serialNumber', layoutHints: ['workstations'], fieldHints: ['serial_number'] },
    standardFields: [
      { sourceField: 'hostname', label: 'Hostname', fieldType: 'TEXT', fieldHints: ['hostname', 'host_name'] },
      { sourceField: 'operating_system', label: 'Operating system', fieldType: 'TEXT', fieldHints: ['operating_system', 'os'] },
      { sourceField: 'ip_address', label: 'IP address', fieldType: 'IP_ADDRESS', fieldHints: ['ip_address', 'ip'] },
      { sourceField: 'ram', label: 'RAM', fieldType: 'TEXT', fieldHints: ['ram', 'memory'] },
    ],
  };
  const standardSelect = (key: string) => screen.getByLabelText(`Layout field for ${key}`);

  beforeEach(() => {
    apiFetch.mockReset();
    toastPush.mockReset();
  });

  it('matches hints by whole words and compatible types only', () => {
    const [hostname, os, ip] = devices.standardFields;
    expect(suggestStandardField(workstations.fields as never, hostname as never)?.id).toBe('f-host');
    // "os" never matches "host_name", and a dropdown never takes a fact.
    expect(suggestStandardField(workstations.fields as never, os as never)).toBeNull();
    expect(suggestStandardField(workstations.fields as never, ip as never)?.id).toBe('f-ip');
    expect(suggestStandardField(workstations.fields as never, hostname as never, new Set(['f-host']))).toBeNull();
  });

  it('never pre-selects an operator-owned field that only contains a hint word', () => {
    const [, os, , ram] = devices.standardFields;
    const owned = [
      typed('f-lic', 'OS license key', 'os_license_key', 'TEXT'),
      typed('f-mem', 'Memory upgrade purchase', 'memory_upgrade_purchase', 'TEXT'),
    ];
    expect(suggestStandardField(owned as never, os as never)).toBeNull();
    expect(suggestStandardField(owned as never, ram as never)).toBeNull();
    expect(suggestStandardField([...owned, typed('f-ram', 'Memory', 'memory', 'TEXT')] as never, ram as never)?.id).toBe('f-ram');
  });

  it('pre-selects hinted fields, creates missing ones, skips Don\'t sync and maps them preserve_manual', async () => {
    apiFetch.mockImplementation(async (path: string, init?: { method?: string; body?: string }) => {
      if (path === '/layouts') return { ok: true, data: { items: [workstations] } };
      if (path.endsWith('/match-field')) return { ok: true, data: { fieldId: 'f-new-os', created: true } };
      if (path.endsWith('/field-mappings') && !init) return { ok: true, data: [] };
      return { ok: true, data: row('devices') };
    });
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('devices')] } as never} driver={{ resources: [devices] } as never} />);
    await screen.findByLabelText('Layout', { selector: '#map-layout-devices' });
    expect(standardSelect('Hostname')).toHaveValue('f-host');
    expect(standardSelect('Operating system')).toHaveValue('__create_field__');
    expect(standardSelect('IP address')).toHaveValue('f-ip');
    expect(standardSelect('RAM')).toHaveValue('__create_field__');
    fireEvent.change(standardSelect('RAM'), { target: { value: '__dont_sync__' } });

    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/devices/field-mappings', {
      method: 'PATCH',
      body: JSON.stringify({ mappings: [
        { sourceField: 'serialNumber', targetFieldId: 'f-serial', syncDirection: 'source_wins', transform: null },
        { sourceField: 'hostname', targetFieldId: 'f-host', syncDirection: 'preserve_manual', transform: null },
        { sourceField: 'operating_system', targetFieldId: 'f-new-os', syncDirection: 'preserve_manual', transform: null },
        { sourceField: 'ip_address', targetFieldId: 'f-ip', syncDirection: 'preserve_manual', transform: null },
      ] }),
    }));
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/i1/resources/devices/match-field', {
      method: 'POST', body: JSON.stringify({ assetLayoutId: 'l-ws', sourceField: 'operating_system' }),
    });
    expect(apiFetch).not.toHaveBeenCalledWith('/admin/integrations/i1/resources/devices/match-field', {
      method: 'POST', body: JSON.stringify({ assetLayoutId: 'l-ws', sourceField: 'ram' }),
    });
  });

  it('refuses to send two facts into one field', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/layouts' ? { ok: true, data: { items: [workstations] } } : { ok: true, data: row('devices') },
    );
    render(<MapLayoutsTab integration={{ id: 'i1', resources: [row('devices')] } as never} driver={{ resources: [devices] } as never} />);
    await screen.findByLabelText('Layout', { selector: '#map-layout-devices' });
    fireEvent.change(standardSelect('RAM'), { target: { value: 'f-host' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save layout mapping' }));
    expect(await screen.findByText(/Each layout field can take only one value/)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('without the layout permission, missing facts default to Don\'t sync and Create field is disabled', async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path === '/layouts' ? { ok: true, data: { items: [workstations] } } : { ok: true, data: row('devices') },
    );
    render(
      <MapLayoutsTab
        integration={{ id: 'i1', resources: [row('devices')] } as never}
        driver={{ resources: [devices] } as never}
        canManageLayouts={false}
      />,
    );
    await screen.findByLabelText('Layout', { selector: '#map-layout-devices' });
    expect(standardSelect('Operating system')).toHaveValue('__dont_sync__');
    expect(screen.getByRole('option', { name: 'Create field "Operating system"' })).toBeDisabled();
  });

  it('keeps saved standard mappings selected', async () => {
    apiFetch.mockImplementation(async (path: string, init?: unknown) => {
      if (path === '/layouts') return { ok: true, data: { items: [workstations] } };
      if (path.endsWith('/field-mappings') && !init) {
        return { ok: true, data: [{ sourceField: 'ram', targetFieldId: 'f-host', syncDirection: 'preserve_manual', transform: null }] };
      }
      return { ok: true, data: row('devices') };
    });
    render(
      <MapLayoutsTab
        integration={{ id: 'i1', resources: [row('devices', { assetLayoutId: 'l-ws', matchKeyFieldIds: ['f-serial'], fieldMappingCount: 2 })] } as never}
        driver={{ resources: [devices] } as never}
      />,
    );
    await screen.findByLabelText('Layout', { selector: '#map-layout-devices' });
    expect(standardSelect('RAM')).toHaveValue('f-host');
    // The saved field is taken, so Hostname does not also claim it.
    expect(standardSelect('Hostname')).toHaveValue('__create_field__');
  });
});
