/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { IntegrationTabs } from './integration-tabs';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock('./credentials-tab', () => ({ CredentialsTab: () => <div>credentials panel</div> }));
jest.mock('./orgs-tab', () => ({ OrgsTab: () => <div>organizations panel</div> }));
jest.mock('./runs-tab', () => ({ RunsTab: () => <div>runs panel</div> }));
jest.mock('./field-mappings-tab', () => ({ FieldMappingsTab: ({ resource }: { resource: { key: string } }) => <div>{resource.key} panel</div> }));
jest.mock('./completeness-tab', () => ({ CompletenessTab: () => <div>completeness panel</div> }));

describe('IntegrationTabs', () => {
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
});
