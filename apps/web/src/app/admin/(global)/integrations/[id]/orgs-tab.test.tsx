/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { OrgsTab } from './orgs-tab';

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock('../../../../../components/ui', () => ({
  Btn: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Icon: { plus: null, chevron: () => null },
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
jest.mock('./create-mapping-dialog', () => ({ CreateMappingDialog: () => <div>mapping dialog</div> }));
jest.mock('./mapping-detail-dialog', () => ({ MappingDetailDialog: () => <div>mapping detail</div> }));

const integration = (hasSecret: boolean) => ({
  id: 'integration-1', hasSecret,
  resources: [{ enabled: true, assetLayoutId: 'layout', fieldMappingCount: 1, resourceLabel: 'Sites' }],
}) as never;

describe('OrgsTab', () => {
  it('shows the empty state and credential gate without enabling mapping creation', () => {
    render(<OrgsTab integration={integration(false)} mappings={[]} driver={null} />);
    expect(screen.getByText(/No company mappings yet/i)).toBeInTheDocument();
    expect(screen.getByText(/Add credentials/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add mapping' })).toBeDisabled();
  });

  it('opens the descriptor-driven mapping action when credentials exist', () => {
    render(<OrgsTab integration={integration(true)} mappings={[]} driver={{ capabilities: { listSourceOrgs: true } } as never} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add mapping' }));
    expect(screen.getByText('mapping dialog')).toBeInTheDocument();
  });
});
