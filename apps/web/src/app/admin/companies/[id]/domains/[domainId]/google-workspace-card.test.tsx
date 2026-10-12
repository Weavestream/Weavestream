/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import type { MonitoredDomainDto } from '@weavestream/shared';
import { GoogleWorkspaceCard } from './google-workspace-card';
import { SourceTags } from '../domains-browser';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function domain(p: Partial<MonitoredDomainDto>): MonitoredDomainDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    companyId: '00000000-0000-4000-8000-0000000000aa',
    hostname: 'example.org',
    source: 'MANUAL',
    registrarMissingSince: null,
    workspaceIntegrationId: '00000000-0000-4000-8000-0000000000cc',
    workspaceRole: null,
    workspaceAliasOf: null,
    workspaceSyncedAt: '2026-10-08T00:00:00.000Z',
    workspaceMissingSince: null,
    microsoftIntegrationId: null,
    microsoftDefault: null,
    microsoftAuthType: null,
    microsoftServices: [],
    microsoftSyncedAt: null,
    microsoftMissingSince: null,
    ...p,
  } as MonitoredDomainDto;
}

describe('Google Workspace on domains', () => {
  it('tags the list row with the Workspace role, including the alias parent', () => {
    const { rerender } = render(<SourceTags row={domain({ workspaceRole: 'ALIAS', workspaceAliasOf: 'example.com' })} />);
    expect(screen.getByRole('img', { name: 'Google Workspace: Domain alias of example.com' })).toBeInTheDocument();
    // Icons only in the list: no role words.
    expect(screen.queryByText(/Alias of/)).toBeNull();
    rerender(<SourceTags row={domain({ workspaceRole: 'PRIMARY', source: 'CLOUDFLARE' })} />);
    expect(screen.getByRole('img', { name: 'Synced from Cloudflare' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Google Workspace: Primary domain' })).toBeInTheDocument();
    expect(screen.queryByText('Cloudflare')).toBeNull();
    // Cloudflare is always listed first.
    expect(screen.getAllByRole('img').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Synced from Cloudflare',
      'Google Workspace: Primary domain',
    ]);
    rerender(<SourceTags row={domain({ workspaceMissingSince: '2026-10-01T00:00:00.000Z' })} />);
    expect(screen.getByText('not in Google Workspace since 2026-10-01')).toBeInTheDocument();
  });

  it('shows the role, verification, integration and icon on the domain page card', () => {
    const { container } = render(
      <GoogleWorkspaceCard
        domain={domain({ workspaceRole: 'SECONDARY', workspaceIntegrationName: 'Example Workspace' })}
      />,
    );
    expect(screen.getByText('Secondary domain')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
    expect(screen.getByText('Example Workspace')).toBeInTheDocument();
    expect(container.querySelector('img[src="/integrations/drivers/google-workspace.svg"]')).not.toBeNull();
  });

  it('flags a domain that left Workspace and hides the integration name when absent', () => {
    render(<GoogleWorkspaceCard domain={domain({ workspaceMissingSince: '2026-10-01T00:00:00.000Z' })} />);
    expect(screen.getByText('Not in Workspace')).toBeInTheDocument();
    expect(screen.getByText('Not in Google Workspace since 2026-10-01')).toBeInTheDocument();
    expect(screen.queryByText('Integration')).toBeNull();
  });
});
