/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { TextEncoder } from 'node:util';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImportDefinitionForm, parseDefinitionImport } from './import-definition';

// jsdom has no TextEncoder; the shared schema uses it for the 64 KiB limit.
Object.assign(globalThis, { TextEncoder });

const apiFetch = jest.fn();
jest.mock('../../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));

const valid = {
  version: 1,
  baseUrl: 'https://inventory.example.com',
  auth: { method: 'bearer' },
  organizations: { mode: 'single' },
  resources: {
    items: { enabled: true, request: { path: '/devices' }, idPath: 'id', namePath: 'name', matchPath: 'serial' },
  },
};

describe('parseDefinitionImport', () => {
  it('refuses more than 64 KiB before parsing', () => {
    expect(parseDefinitionImport(' '.repeat(64 * 1024 + 1))).toEqual({ ok: false, errors: ['The file is larger than 64 KiB.'] });
  });

  it('refuses text that is not JSON', () => {
    expect(parseDefinitionImport('{ nope')).toEqual({ ok: false, errors: ['This is not valid JSON.'] });
  });

  it('lists each schema error with its path', () => {
    const result = parseDefinitionImport(
      JSON.stringify({ ...valid, baseUrl: 'http://inventory.example.com', headers: [{ name: 'Authorization', value: 'x' }] }),
    );
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    expect(errors).toContain('baseUrl: Base URL must start with https://.');
    expect(errors.some((e) => e.startsWith('headers.0.name:'))).toBe(true);
  });

  it('returns the file’s own JSON for a valid definition', () => {
    expect(parseDefinitionImport(JSON.stringify(valid))).toEqual({ ok: true, definition: valid });
  });
});

describe('ImportDefinitionForm', () => {
  it('fills the form from pasted text and saves nothing', () => {
    const onImport = jest.fn();
    render(<ImportDefinitionForm onImport={onImport} onCancel={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('Or paste the definition'), { target: { value: JSON.stringify(valid) } });
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(onImport).toHaveBeenCalledWith(valid);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows the errors and does not import an invalid file', async () => {
    const onImport = jest.fn();
    render(<ImportDefinitionForm onImport={onImport} onCancel={jest.fn()} />);
    const file = new File([JSON.stringify({ ...valid, version: 2 })], 'def.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Definition file'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('Or paste the definition')).not.toHaveValue(''));
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/^version:/);
    expect(onImport).not.toHaveBeenCalled();
  });

  it('refuses a file over 64 KiB without reading it', () => {
    render(<ImportDefinitionForm onImport={jest.fn()} onCancel={jest.fn()} />);
    const file = new File(['x'.repeat(64 * 1024 + 1)], 'big.json');
    fireEvent.change(screen.getByLabelText('Definition file'), { target: { files: [file] } });
    expect(screen.getByRole('alert')).toHaveTextContent('The file is larger than 64 KiB.');
  });
});
