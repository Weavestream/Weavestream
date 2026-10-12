/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { MonitoredDomainDto } from '@weavestream/shared';
import { Microsoft365Card } from './microsoft-365-card';
import { SourceTags } from '../domains-browser';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function domain(p: Partial<MonitoredDomainDto>): MonitoredDomainDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    companyId: '00000000-0000-4000-8000-0000000000aa',
    hostname: 'contoso.example',
    source: 'MANUAL',
    registrarMissingSince: null,
    workspaceIntegrationId: null,
    workspaceRole: null,
    workspaceAliasOf: null,
    workspaceSyncedAt: null,
    workspaceMissingSince: null,
    microsoftIntegrationId: '00000000-0000-4000-8000-0000000000dd',
    microsoftDefault: null,
    microsoftAuthType: null,
    microsoftServices: [],
    microsoftSyncedAt: '2026-10-08T00:00:00.000Z',
    microsoftMissingSince: null,
    ...p,
  } as MonitoredDomainDto;
}

describe('Microsoft 365 on domains', () => {
  it('lists source icons in order Cloudflare, Google, Microsoft, with no words', () => {
    render(<SourceTags row={domain({ source: 'CLOUDFLARE', workspaceRole: 'PRIMARY', microsoftDefault: true })} />);
    expect(screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Synced from Cloudflare',
      'Google Workspace: Primary domain',
      'Microsoft 365: Default domain',
    ]);
    expect(screen.queryByText('Microsoft 365')).toBeNull();
    expect(document.querySelector('img[src="/integrations/icons/microsoft.svg"]')).not.toBeNull();
  });

  it('shows a Microsoft-only row and flags one that left the tenant', () => {
    const { rerender } = render(<SourceTags row={domain({ microsoftDefault: false })} />);
    expect(screen.getByRole('img', { name: 'Microsoft 365: Verified domain' })).toBeInTheDocument();
    rerender(<SourceTags row={domain({ microsoftMissingSince: '2026-10-01T00:00:00.000Z' })} />);
    expect(screen.getByText('not in Microsoft 365 since 2026-10-01')).toBeInTheDocument();
  });

  it('shows default, verified, managed/federated, services, sync and integration on the card', () => {
    const { container } = render(
      <Microsoft365Card
        domain={domain({
          microsoftDefault: true,
          microsoftAuthType: 'FEDERATED',
          microsoftServices: ['Email', 'OfficeCommunicationsOnline', 'CustomThing'],
          microsoftIntegrationName: 'Contoso tenant',
        })}
      />,
    );
    expect(screen.getByText('Default domain')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('Federated')).toBeInTheDocument();
    expect(screen.getByText('Email, Teams, CustomThing')).toBeInTheDocument();
    expect(screen.getByText('Contoso tenant')).toBeInTheDocument();
    expect(container.querySelector('img[src="/integrations/drivers/microsoft-365.svg"]')).not.toBeNull();
  });

  it('hides the integration name when the API leaves it out (client users)', () => {
    render(<Microsoft365Card domain={domain({ microsoftDefault: false, microsoftIntegrationName: null })} />);
    expect(screen.getByText('Verified domain')).toBeInTheDocument();
    expect(screen.queryByText('Integration')).toBeNull();
  });
});
