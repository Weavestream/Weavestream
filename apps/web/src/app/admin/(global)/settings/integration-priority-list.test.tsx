/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ToastProvider } from '../../../../components/ui';
import { IntegrationPriorityList, moveEntry } from './integration-priority-list';

const apiFetch = jest.fn();
const refresh = jest.fn();

jest.mock('../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const initial = [
  { key: 'level', label: 'Level RMM' },
  { key: 'microsoft-365', label: 'Microsoft 365' },
  { key: 'google-workspace', label: 'Google Workspace' },
];

function renderList() {
  render(<ToastProvider><IntegrationPriorityList initial={initial} /></ToastProvider>);
  return () => within(screen.getByRole('list', { name: /Integration priority/ })).getAllByRole('listitem').map((li) => li.textContent);
}

beforeEach(() => {
  apiFetch.mockReset();
  refresh.mockReset();
});

describe('IntegrationPriorityList', () => {
  it('moveEntry moves one item and ignores out-of-range moves', () => {
    expect(moveEntry(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveEntry(['a', 'b'], 0, 5)).toEqual(['a', 'b']);
  });

  it('reorders with the Up and Down buttons and saves the full order through the step-up route', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: {} });
    const rows = renderList();
    expect(screen.getByRole('button', { name: 'Save order' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Level RMM up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Google Workspace up' }));
    expect(rows()[1]).toContain('Google Workspace');
    fireEvent.click(screen.getByRole('button', { name: 'Move Level RMM down' }));
    expect(rows()[0]).toContain('Google Workspace');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    expect(apiFetch).toHaveBeenCalledWith('/settings/integration-priority', {
      method: 'PUT',
      body: JSON.stringify({ order: ['google-workspace', 'level', 'microsoft-365'] }),
    });
    expect(refresh).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save order' })).toBeDisabled();
  });

  it('reorders by drag and drop', () => {
    const rows = renderList();
    const items = screen.getAllByRole('listitem');
    fireEvent.dragStart(items[2]!);
    fireEvent.dragOver(items[0]!);
    fireEvent.drop(items[0]!);
    expect(rows()[0]).toContain('Google Workspace');
  });

  it('keeps the edit when the step-up is cancelled', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, stepUpCancelled: true, problem: null });
    renderList();
    fireEvent.click(screen.getByRole('button', { name: 'Move Microsoft 365 up' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save order' }));
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save order' })).toBeEnabled();
  });
});
