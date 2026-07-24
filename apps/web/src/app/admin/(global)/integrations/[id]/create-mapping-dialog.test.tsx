/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateMappingDialog } from './create-mapping-dialog';

const apiFetch = jest.fn();
const toast = { push: jest.fn() };
const onCreated = jest.fn();

jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('../../../../../components/ui', () => ({
  Btn: ({ children, loading: _loading, kind: _kind, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & Record<string, unknown>) => <button {...props}>{children}</button>,
  CompanyPicker: ({ onChange }: { onChange: (value: { id: string; name: string }) => void }) => <button onClick={() => onChange({ id: 'company-1', name: 'Company One' })}>Choose company</button>,
  Dialog: ({ title, children, footer }: { title: string; children: React.ReactNode; footer: React.ReactNode }) => <section aria-label={title}>{children}{footer}</section>,
  Field: ({ label, children }: { label: string; children: React.ReactNode }) => <label>{label}{children}</label>,
  Select: (props: React.SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />,
  Tag: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  useToast: () => toast,
}));

const driver = { capabilities: { listSourceOrgs: true } } as never;

describe('CreateMappingDialog', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    toast.push.mockReset();
    onCreated.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      data: { orgs: [{ externalId: 'org-1', name: 'Acme' }, { externalId: 'org-2', name: 'Other' }] },
    });
  });

  async function selectMapping() {
    await screen.findByRole('option', { name: 'Acme' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'org-1' } });
    fireEvent.click(screen.getByText('Choose company'));
  }

  it('creates through the existing route and reports success through useToast', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, data: { id: 'mapping-1' } });
    render(<CreateMappingDialog integrationId="integration-1" driver={driver} hasGlobalLayout existingExternalOrgIds={[]} onClose={jest.fn()} onCreated={onCreated} />);
    await selectMapping();
    fireEvent.click(screen.getByRole('button', { name: 'Create mapping' }));

    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith('/admin/integrations/integration-1/mappings', {
      method: 'POST',
      body: JSON.stringify({ companyId: 'company-1', externalOrgId: 'org-1', externalOrgName: 'Acme', enabled: true, filter: {} }),
    }));
    expect(toast.push).toHaveBeenCalledWith('Mapping created.', 'ok');
    expect(onCreated).toHaveBeenCalled();
  });

  it('reports mapping creation failures through useToast', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, problem: { detail: 'Already mapped' } });
    render(<CreateMappingDialog integrationId="integration-1" driver={driver} hasGlobalLayout existingExternalOrgIds={[]} onClose={jest.fn()} onCreated={onCreated} />);
    await selectMapping();
    fireEvent.click(screen.getByRole('button', { name: 'Create mapping' }));

    await waitFor(() => expect(toast.push).toHaveBeenCalledWith('Already mapped', 'danger'));
    expect(onCreated).not.toHaveBeenCalled();
  });
});
