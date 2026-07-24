/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MappingDetailDialog } from './mapping-detail-dialog';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const changedAction = jest.fn();

jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../../lib/timezone-context', () => ({ FormattedDateTime: ({ value }: { value: string }) => <span>{value}</span> }));
jest.mock('../../../../../components/ui', () => ({
  Btn: ({ children, loading: _loading, icon: _icon, kind: _kind, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => <button {...props}>{children}</button>,
  Dialog: ({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) => <section aria-label={title}>{children}{footer}</section>,
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => <label>{label}{children}</label>,
  Icon: { trash: null },
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => toast,
}));

const integration = { id: 'integration-1' } as never;
const mapping = {
  id: 'mapping-1', companyId: 'company-1', companyName: 'Company One', externalOrgId: 'org-1',
  externalOrgName: 'Acme', enabled: true, updatedAt: '2026-07-14T00:00:00.000Z',
} as never;

describe('MappingDetailDialog', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toast.push.mockReset();
    changedAction.mockReset();
  });

  it('saves through the existing route and reports success through useToast', async () => {
    apiFetch.mockResolvedValue({ ok: true, data: {} });
    render(<MappingDetailDialog integration={integration} mapping={mapping} closeAction={jest.fn()} changedAction={changedAction} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'off' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/admin/integrations/integration-1/mappings/mapping-1', {
      method: 'PATCH', body: JSON.stringify({ enabled: false }),
    }));
    expect(toast.push).toHaveBeenCalledWith('Mapping saved.', 'ok');
    expect(changedAction).toHaveBeenCalled();
  });

  it('reports mapping save failures through useToast', async () => {
    apiFetch.mockResolvedValue({ ok: false, problem: { detail: 'Could not update' } });
    render(<MappingDetailDialog integration={integration} mapping={mapping} closeAction={jest.fn()} changedAction={changedAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(toast.push).toHaveBeenCalledWith('Could not update', 'danger'));
    expect(changedAction).not.toHaveBeenCalled();
  });
});
