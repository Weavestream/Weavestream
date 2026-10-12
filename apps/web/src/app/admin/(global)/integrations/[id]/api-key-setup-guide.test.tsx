/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiKeySetupGuide } from './api-key-setup-guide';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };

jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../../components/ui', () => ({
  Btn: ({ children, loading: _loading, icon: _icon, kind: _kind, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => <button {...props}>{children}</button>,
  Icon: new Proxy({}, { get: () => () => null }),
  useToast: () => toast,
}));

const steps = [
  { id: 'api-key', title: 'Create a read-only API key', body: 'In the provider, create a key.' },
  { id: 'credentials', title: 'Paste the key', body: 'Paste it and save.' },
];

describe('ApiKeySetupGuide', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toast.push.mockReset();
  });

  it('disables Check setup until a key is saved', () => {
    render(<ApiKeySetupGuide integrationId="integration-1" steps={steps} hasSecret={false} />);
    expect(screen.getByRole('button', { name: 'Check setup' })).toBeDisabled();
    expect(screen.getByText('Save the API key first, then press Check setup.')).toBeInTheDocument();
  });

  it('runs the check through the existing route and shows a failed step', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: { ok: false, passedStepIds: ['credentials'], failures: [{ stepId: 'api-key', message: 'The key was revoked.' }] },
    });
    render(<ApiKeySetupGuide integrationId="integration-1" steps={steps} hasSecret />);
    // Collapsed once a key is saved.
    expect(screen.queryByText('Paste the key')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Setup guide/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Check setup' }));
    await waitFor(() => expect(screen.getByText('The key was revoked.')).toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/integration-1/check', { method: 'POST', body: JSON.stringify({}) });
  });

  it('recovers when the request itself fails', async () => {
    apiFetch.mockRejectedValue(new Error('network down'));
    render(<ApiKeySetupGuide integrationId="integration-1" steps={steps} hasSecret />);
    fireEvent.click(screen.getByRole('button', { name: 'Check setup' }));
    await waitFor(() => expect(toast.push).toHaveBeenCalledWith('Could not run the setup check.', 'danger'));
    expect(screen.getByRole('button', { name: 'Check setup' })).not.toBeDisabled();
  });
});
