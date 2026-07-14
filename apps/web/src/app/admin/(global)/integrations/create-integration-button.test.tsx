/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateIntegrationButton } from './create-integration-button';

const apiFetch = jest.fn();
const push = jest.fn();
const refresh = jest.fn();
const toast = { push: jest.fn() };

jest.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh }) }));
jest.mock('../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../components/ui', () => ({
  Btn: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Dialog: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) =>
    open ? <section aria-label={title}>{children}{footer}</section> : null,
  Field: ({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) => <label htmlFor={htmlFor}>{label}{children}</label>,
  Icon: { plus: null },
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => toast,
}));

const breeze = {
  key: 'breeze', label: 'Breeze RMM', description: 'Breeze reconstruction', iconKey: 'breeze',
  configFields: [{ key: 'baseUrl', label: 'Breeze URL', kind: 'url', required: true }],
  secretFields: [{ key: 'apiKey', label: 'Partner API key', kind: 'password', required: true }],
  resources: [],
  capabilities: { kind: 'pull', listSourceOrgs: true, dryRun: true, ticketing: false },
} as never;

describe('CreateIntegrationButton', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders Breeze config and secret fields from its descriptor and creates through the generic route', async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { id: 'integration-1' } });
    render(<CreateIntegrationButton drivers={[breeze]} />);

    fireEvent.click(screen.getByRole('button', { name: 'New integration' }));
    expect(screen.getByRole('option', { name: 'Breeze RMM' })).toBeInTheDocument();
    expect(screen.getByLabelText('Breeze URL *')).toHaveAttribute('type', 'url');
    expect(screen.getByLabelText('Partner API key *')).toHaveAttribute('type', 'password');

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Breeze production' } });
    fireEvent.change(screen.getByLabelText('Breeze URL *'), { target: { value: 'https://breeze.example' } });
    fireEvent.change(screen.getByLabelText('Partner API key *'), { target: { value: 'secret-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        driver: 'breeze', name: 'Breeze production', config: { baseUrl: 'https://breeze.example' },
        secret: { apiKey: 'secret-key' }, status: 'PAUSED',
      }),
    })));
    expect(toast.push).toHaveBeenCalledWith('Integration created.', 'ok');
    expect(push).toHaveBeenCalledWith('/admin/integrations/integration-1');
  });
});
