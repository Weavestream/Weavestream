/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { DriverFieldsEditor } from './driver-fields-editor';

const apiFetch = jest.fn();
jest.mock('../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const field = {
  key: 'domainsCompanySlug',
  label: 'Sync domains into company',
  kind: 'company' as const,
  required: false,
};

afterEach(() => apiFetch.mockReset());

it('shows the saved company by name, looked up from its slug', async () => {
  apiFetch.mockResolvedValue({
    ok: true,
    data: {
      items: [
        { id: 'c-2', name: 'Acme Labs', slug: 'acme-labs', archivedAt: null },
        { id: 'c-1', name: 'Acme Industries', slug: 'acme-industries', archivedAt: null },
      ],
    },
  });
  render(
    <DriverFieldsEditor
      title="Configuration"
      fields={[field]}
      values={{ domainsCompanySlug: 'acme-industries' }}
      onChange={() => undefined}
    />,
  );
  expect(await screen.findByText('Acme Industries')).toBeInTheDocument();
  expect(apiFetch.mock.calls[0][0]).toMatch(/^\/companies\?q=acme-industries/);
});

it('turns domain sync off when the company is cleared', async () => {
  apiFetch.mockResolvedValue({
    ok: true,
    data: { items: [{ id: 'c-1', name: 'Acme Industries', slug: 'acme-industries', archivedAt: null }] },
  });
  const onChange = jest.fn();
  render(
    <DriverFieldsEditor
      title="Configuration"
      fields={[field]}
      values={{ accountId: 'acct', domainsCompanySlug: 'acme-industries' }}
      onChange={onChange}
    />,
  );
  await screen.findByText('Acme Industries');
  fireEvent.click(screen.getByRole('button', { name: 'Clear selected company' }));
  expect(onChange).toHaveBeenCalledWith({ accountId: 'acct', domainsCompanySlug: undefined });
});

it('still shows a saved slug the user cannot list', async () => {
  apiFetch.mockResolvedValue({ ok: true, data: { items: [] } });
  render(
    <DriverFieldsEditor
      title="Configuration"
      fields={[field]}
      values={{ domainsCompanySlug: 'hidden-co' }}
      onChange={() => undefined}
    />,
  );
  expect((await screen.findAllByText(/hidden-co/)).length).toBeGreaterThan(0);
});
