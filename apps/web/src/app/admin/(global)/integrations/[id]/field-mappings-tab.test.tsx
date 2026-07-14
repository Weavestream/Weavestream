/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FieldMappingsTab } from './field-mappings-tab';

const apiFetch = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../../components/ui', () => ({
  Btn: ({ children, loading: _loading, icon: _icon, iconOnly: _iconOnly, kind: _kind, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => <button {...props}>{children}</button>,
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => <label>{label}{children}</label>,
  Icon: { plus: null, trash: null },
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => ({ push: jest.fn() }),
}));

const resourceRow = (overrides: Record<string, unknown>) => ({
  id: '00000000-0000-4000-8000-000000000003', integrationId: 'integration-1',
  resourceKey: 'scripts', resourceLabel: 'Scripts', enabled: true,
  targetKind: 'article', targetConfig: { sourceEndpoint: '/scripts', folderSlug: 'scripts', visibility: 'internal' },
  dependsOnResourceKeys: [], assetLayoutId: null, assetLayoutName: null,
  matchKeyFieldIds: [], fieldMappingCount: 0, createdAt: '', updatedAt: '', ...overrides,
});

describe('FieldMappingsTab target-aware configuration', () => {
  beforeEach(() => apiFetch.mockReset());

  it('shows bounded article controls and hides generic asset layout/mapping controls', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: resourceRow({}) });
    render(<FieldMappingsTab
      integration={{ id: 'integration-1', resources: [resourceRow({})] } as never}
      mappings={[]} driver={{} as never}
      resource={{ key: 'scripts', label: 'Scripts', targetKind: 'article', targetConfig: resourceRow({}).targetConfig, dependsOnResourceKeys: [] } as never}
    />);
    expect(screen.getByLabelText('Folder slug')).toHaveValue('scripts');
    expect(screen.getByLabelText('Visibility')).toHaveValue('internal');
    expect(screen.getByLabelText('Article template')).toBeInTheDocument();
    expect(screen.queryByText('Target asset layout')).not.toBeInTheDocument();
    expect(screen.queryByText('Field projections')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Folder slug'), { target: { value: 'procedures' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(
      '/admin/integrations/integration-1/resources/scripts',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('procedures'),
      }),
    ));
  });

  it('shows IP normalization/match explanation and relation dependencies/type mapping', () => {
    const { rerender } = render(<FieldMappingsTab
      integration={{ id: 'integration-1', resources: [resourceRow({
        resourceKey: 'subnets', resourceLabel: 'Subnets', targetKind: 'subnet',
        targetConfig: { sourceEndpoint: '/device-inventory', normalization: 'cidr' },
      })] } as never}
      mappings={[]} driver={{} as never}
      resource={{ key: 'subnets', label: 'Subnets', targetKind: 'subnet', targetConfig: { normalization: 'cidr' }, dependsOnResourceKeys: ['devices'] } as never}
    />);
    expect(screen.getByText(/CIDR normalization/i)).toBeInTheDocument();
    expect(screen.getByText(/native subnet identity/i)).toBeInTheDocument();

    rerender(<FieldMappingsTab
      integration={{ id: 'integration-1', resources: [resourceRow({
        resourceKey: 'relations', resourceLabel: 'Relations', targetKind: 'relation',
        targetConfig: { sourceEndpoint: '/device-relationships', typeMapping: { host_vm: 'depends_on' } },
        dependsOnResourceKeys: ['devices', 'scripts'],
      })] } as never}
      mappings={[]} driver={{} as never}
      resource={{ key: 'relations', label: 'Relations', targetKind: 'relation', targetConfig: { typeMapping: { host_vm: 'depends_on' } }, dependsOnResourceKeys: ['devices', 'scripts'] } as never}
    />);
    expect(screen.getByText(/devices, scripts/)).toBeInTheDocument();
    expect(screen.getByLabelText('Type mapping (JSON)')).toHaveValue('{\n  "host_vm": "depends_on"\n}');
  });

  it('uses target-aware enable instructions for disabled article and relation resources', () => {
    render(<>
      <FieldMappingsTab
        integration={{ id: 'integration-1', resources: [] } as never}
        mappings={[]} driver={{} as never}
        resource={{
          key: 'scripts', label: 'Scripts', targetKind: 'article',
          targetConfig: { folderSlug: 'scripts' }, dependsOnResourceKeys: [],
        } as never}
      />
      <FieldMappingsTab
        integration={{ id: 'integration-1', resources: [] } as never}
        mappings={[]} driver={{} as never}
        resource={{
          key: 'relationships', label: 'Relationships', targetKind: 'relation',
          targetConfig: {}, dependsOnResourceKeys: ['devices'],
        } as never}
      />
    </>);
    expect(screen.getByText(/destination folder, visibility, and article template/i)).toBeInTheDocument();
    expect(screen.getByText(/dependency resources and relationship type mapping/i)).toBeInTheDocument();
    expect(screen.queryByText(/asset layout|match-key|project upstream/i)).not.toBeInTheDocument();
  });

  it('round-trips every existing transform step when saving an asset mapping', async () => {
    const assetResource = resourceRow({
      resourceKey: 'devices', resourceLabel: 'Devices', targetKind: 'asset', targetConfig: {},
      assetLayoutId: '00000000-0000-4000-8000-000000000010',
    });
    apiFetch.mockImplementation(async (url: string, options?: { method?: string }) => {
      if (url === '/layouts') return { ok: true, data: { items: [{ id: assetResource.assetLayoutId, name: 'Devices', isActive: true, archivedAt: null }] } };
      if (url.startsWith('/layouts/')) return { ok: true, data: { layout: { fields: [{ id: '00000000-0000-4000-8000-000000000011', name: 'Hostname', fieldType: 'TEXT', archivedAt: null }] } } };
      if (url.endsWith('/field-mappings') && options?.method !== 'PATCH') return { ok: true, data: [{
        id: 'mapping-row', sourceField: 'hostname', targetFieldId: '00000000-0000-4000-8000-000000000011',
        targetPath: null, syncDirection: 'source_wins',
        transform: { steps: [{ op: 'trim' }, { op: 'lowercase' }, { op: 'join', paths: ['site', 'name'], separator: ' / ' }] },
      }] };
      if (url.endsWith('/source-fields')) return { ok: true, data: { fields: [{ key: 'hostname', label: 'Hostname' }] } };
      return { ok: true, data: assetResource };
    });
    render(<FieldMappingsTab
      integration={{ id: 'integration-1', resources: [assetResource] } as never}
      mappings={[{}] as never} driver={{} as never}
      resource={{ key: 'devices', label: 'Devices', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [] } as never}
    />);
    await waitFor(() => expect(screen.getByLabelText('Source field')).toHaveValue('hostname'));
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([url, options]) => String(url).endsWith('/field-mappings') && (options as { method?: string })?.method === 'PATCH');
      expect(JSON.parse((call?.[1] as { body: string }).body).mappings[0].transform).toEqual({
        steps: [{ op: 'trim' }, { op: 'lowercase' }, { op: 'join', paths: ['site', 'name'], separator: ' / ' }],
      });
    });
  });
});
