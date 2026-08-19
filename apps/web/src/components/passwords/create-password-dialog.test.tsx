/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { CreatePasswordDialog } from './create-password-dialog';

const apiFetch = jest.fn();
jest.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

describe('CreatePasswordDialog URL validation', () => {
  beforeEach(() => apiFetch.mockClear());

  it('shows a field error, preserves the value, and prevents submission', () => {
    render(
      <CreatePasswordDialog
        companyId="co-1"
        folders={[]}
        onCloseAction={() => {}}
        onCreatedAction={() => {}}
      />,
    );

    fireEvent.change(screen.getAllByRole('textbox')[0]!, {
      target: { value: 'Router' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    const url = screen.getByLabelText('URL');
    fireEvent.change(url, { target: { value: 'javascript:alert(1)' } });

    expect(url).toHaveValue('javascript:alert(1)');
    expect(screen.getByRole('alert')).toHaveTextContent(/starting with http:\/\//i);
    expect(screen.getByRole('button', { name: 'Create password' })).toBeDisabled();
    expect(apiFetch).not.toHaveBeenCalled();

    fireEvent.change(url, { target: { value: 'https://router.example/admin' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create password' })).toBeEnabled();
  });
});
