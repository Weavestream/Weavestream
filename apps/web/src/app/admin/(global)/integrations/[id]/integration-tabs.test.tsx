/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { IntegrationTabs } from './integration-tabs';

const mockReplace = jest.fn();
jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('./credentials-tab', () => ({ CredentialsTab: () => <div>credentials panel</div> }));
jest.mock('./orgs-tab', () => ({ OrgsTab: () => <div>organizations panel</div> }));
jest.mock('./runs-tab', () => ({ RunsTab: () => <div>runs panel</div> }));
jest.mock('./field-mappings-tab', () => ({ FieldMappingsTab: ({ resource }: { resource: { key: string } }) => <div>{resource.key} panel</div> }));
jest.mock('./completeness-tab', () => ({ CompletenessTab: () => <div>completeness panel</div> }));

describe('IntegrationTabs', () => {
  beforeEach(() => mockReplace.mockReset());

  it('renders credentials, organizations, then Breeze site/device resource tabs in descriptor order', () => {
    const driver = {
      resources: [
        { key: 'sites', label: 'Sites', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [] },
        { key: 'devices', label: 'Devices', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: ['sites'] },
      ],
    } as never;
    render(<IntegrationTabs
      initialTab="creds"
      integration={{ id: 'integration-1' } as never}
      mappings={[]}
      runs={[]}
      driver={driver}
    />);

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Credentials & schedule', 'Organizations', 'Sites fields', 'Devices fields', 'Completeness', 'Run history',
    ]);
  });

  it('uses target-kind-aware resource tab labels and help', () => {
    const driver = { resources: [
      { key: 'scripts', label: 'Scripts', targetKind: 'article', targetConfig: {}, dependsOnResourceKeys: [] },
      { key: 'relationships', label: 'Relationships', targetKind: 'relation', targetConfig: {}, dependsOnResourceKeys: ['scripts'] },
    ] } as never;
    render(<IntegrationTabs
      initialTab="creds" integration={{ id: 'integration-1' } as never}
      mappings={[]} runs={[]} driver={driver}
    />);
    expect(screen.getByRole('tab', { name: 'Scripts articles' })).toHaveAttribute(
      'title', expect.stringMatching(/folder, visibility, and template/i),
    );
    expect(screen.getByRole('tab', { name: 'Relationships dependencies' })).toHaveAttribute(
      'title', expect.stringMatching(/dependency resources and type mapping/i),
    );
    expect(screen.queryByRole('tab', { name: /Scripts fields|Relationships fields/ })).not.toBeInTheDocument();
  });

  it('supports roving keyboard focus and complete tab/tabpanel relationships', () => {
    render(<IntegrationTabs
      initialTab="creds" integration={{ id: 'integration-1' } as never}
      mappings={[]} runs={[]} driver={{ resources: [
        { key: 'sites', label: 'Sites', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [] },
      ] } as never}
    />);
    const credentials = screen.getByRole('tab', { name: 'Credentials & schedule' });
    expect(credentials).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Organizations' })).toHaveAttribute('tabindex', '-1');
    credentials.focus();

    fireEvent.keyDown(credentials, { key: 'ArrowRight' });
    const organizations = screen.getByRole('tab', { name: 'Organizations' });
    expect(organizations).toHaveFocus();
    expect(organizations).toHaveAttribute('aria-selected', 'true');
    expect(mockReplace).toHaveBeenLastCalledWith(expect.stringContaining('tab=orgs'));

    fireEvent.keyDown(organizations, { key: 'End' });
    const runs = screen.getByRole('tab', { name: 'Run history' });
    expect(runs).toHaveFocus();
    expect(runs).toHaveAttribute('aria-selected', 'true');
    expect(mockReplace).toHaveBeenLastCalledWith(expect.stringContaining('tab=runs'));

    const panel = screen.getByRole('tabpanel');
    expect(runs).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', runs.id);

    fireEvent.keyDown(runs, { key: 'Home' });
    expect(credentials).toHaveFocus();
    expect(credentials).toHaveAttribute('aria-selected', 'true');
    expect(mockReplace).toHaveBeenLastCalledWith(expect.stringContaining('tab=creds'));

    fireEvent.keyDown(credentials, { key: 'ArrowLeft' });
    expect(runs).toHaveFocus();
    expect(runs).toHaveAttribute('aria-selected', 'true');
    expect(mockReplace).toHaveBeenLastCalledWith(expect.stringContaining('tab=runs'));
  });
});
