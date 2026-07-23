/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CredentialsTab } from './credentials-tab';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const refresh = jest.fn();

jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh, push: jest.fn() }) }));
jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../../components/ui', () => ({
  Btn: ({ children, loading: _loading, icon: _icon, kind: _kind, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => <button {...props}>{children}</button>,
  Field: ({ label, htmlFor, help, children }: { label: string; htmlFor?: string; help?: React.ReactNode; children: React.ReactNode }) => <><label htmlFor={htmlFor}>{label}{children}</label>{help && <span>{help}</span>}</>,
  Icon: { refresh: null, zap: null, eye: null, sync: null, trash: null },
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => toast,
}));

const driver = {
  configFields: [{ key: 'baseUrl', label: 'Breeze URL', kind: 'url', required: true }],
  secretFields: [{ key: 'apiKey', label: 'Partner API key', kind: 'password', required: true }],
  capabilities: { kind: 'pull' },
} as never;
const integration = {
  id: 'integration-1', name: 'Breeze', status: 'PAUSED', syncCron: null,
  config: { baseUrl: 'https://breeze.example' }, hasSecret: true,
  secretMask: { apiKey: '••••1234' },
  resources: [{ enabled: true, assetLayoutId: 'layout', fieldMappingCount: 1 }],
};
const mappings = [{ enabled: true }] as never;

describe('CredentialsTab', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toast.push.mockReset();
    refresh.mockReset();
    apiFetch.mockResolvedValue({ ok: true, data: { id: 'run-1' } });
  });

  it('shows only the masked credential until explicit rotation and saves through the existing route', async () => {
    render(<CredentialsTab integration={integration as never} mappings={mappings} driver={driver} />);
    expect(screen.getByText('••••1234')).toBeInTheDocument();
    expect(screen.queryByLabelText('Partner API key *')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }));
    const input = screen.getByLabelText('Partner API key *');
    expect(input).toHaveValue('');
    fireEvent.change(input, { target: { value: 'replacement-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/integration-1', {
      method: 'PATCH', body: JSON.stringify({ secret: { apiKey: 'replacement-secret' } }),
    }));
    expect(toast.push).toHaveBeenCalledWith('Integration saved.', 'ok');
  });

  it.each([
    ['Dry run', true, 'Dry run enqueued.'],
    ['Run sync now', false, 'Sync run enqueued.'],
  ])('uses the existing sync route for %s and reports success through useToast', async (label, dryRun, message) => {
    render(<CredentialsTab integration={integration as never} mappings={mappings} driver={driver} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/integration-1/sync', {
      method: 'POST', body: JSON.stringify({ dryRun }),
    }));
    expect(toast.push).toHaveBeenCalledWith(message, 'ok');
  });

  it('tests the connection through the existing route and uses failure toast feedback', async () => {
    apiFetch.mockResolvedValue({ ok: false, problem: { detail: 'Unauthorized' } });
    render(<CredentialsTab integration={integration as never} mappings={mappings} driver={driver} />);
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(toast.push).toHaveBeenCalledWith('Unauthorized', 'danger'));
  });

  it('blocks manual and dry runs while the integration is disabled', () => {
    render(<CredentialsTab integration={{ ...integration, status: 'DISABLED' } as never} mappings={mappings} driver={driver} />);
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run sync now' })).toBeDisabled();
  });

  it('explains schedule inheritance while no interval is chosen', () => {
    render(<CredentialsTab integration={integration as never} mappings={mappings} driver={driver} />);
    expect(screen.getByLabelText('Sync schedule')).toHaveValue('');
    expect(screen.getByText(/inherits the global default/i)).toHaveTextContent(/off/i);
  });

  it('saves a picked interval preset as the stored cron', async () => {
    render(<CredentialsTab integration={integration as never} mappings={mappings} driver={driver} />);
    fireEvent.change(screen.getByLabelText('Sync schedule'), { target: { value: '*/30 * * * *' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/integration-1', {
      method: 'PATCH', body: JSON.stringify({ syncCron: '*/30 * * * *' }),
    }));
  });

  it('surfaces a legacy hand-written cron as a Custom option and can clear back to inherit', async () => {
    render(<CredentialsTab integration={{ ...integration, syncCron: '7 3 * * 2' } as never} mappings={mappings} driver={driver} />);
    const select = screen.getByLabelText('Sync schedule');
    expect(select).toHaveValue('7 3 * * 2');
    expect(screen.getByRole('option', { name: 'Custom — 7 3 * * 2 (UTC cron)' })).toBeInTheDocument();

    fireEvent.change(select, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/integration-1', {
      method: 'PATCH', body: JSON.stringify({ syncCron: null }),
    }));
  });

  it('reports credential-save failures without echoing secrets', async () => {
    apiFetch.mockResolvedValue({ ok: false, problem: { detail: 'Rejected replacement-secret' } });
    render(<CredentialsTab integration={integration as never} mappings={mappings} driver={driver} />);
    fireEvent.click(screen.getByRole('button', { name: 'Rotate credentials' }));
    fireEvent.change(screen.getByLabelText('Partner API key *'), { target: { value: 'replacement-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(toast.push).toHaveBeenCalledWith('Could not save changes.', 'danger'));
    expect(JSON.stringify(toast.push.mock.calls)).not.toContain('replacement-secret');
  });
});
