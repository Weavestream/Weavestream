/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { ApiKeysList } from './api-keys-list';

/**
 * A key is read-only unless its owner deliberately allows changes, and the
 * page must not offer to mint a key the server will refuse because the
 * instance switch is off.
 */

const apiFetch = jest.fn();
const refresh = jest.fn();

jest.mock('../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
jest.mock('../../lib/timezone-context', () => ({ FormattedRelative: () => null }));

function renderList(props: { enabled?: boolean } = {}) {
  render(
    <ToastProvider>
      <ApiKeysList keys={[]} enabled={props.enabled ?? true} />
    </ToastProvider>,
  );
}

async function createKey({ allowChanges }: { allowChanges: boolean }) {
  fireEvent.click(screen.getByRole('button', { name: 'New API key' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'MCP' } });
  if (allowChanges) fireEvent.click(screen.getByLabelText(/Allow this key to make changes/));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
  });
  return JSON.parse(String(apiFetch.mock.calls[0][1].body)) as Record<string, unknown>;
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: false, status: 500, data: null });
});

describe('ApiKeysList', () => {
  it('creates a read-only key by default', async () => {
    renderList();
    const body = await createKey({ allowChanges: false });
    expect(body).toMatchObject({ allowWrite: false, allowPasswordReveal: false });
  });

  it('asks for write access only when the owner ticks it', async () => {
    renderList();
    const body = await createKey({ allowChanges: true });
    expect(body.allowWrite).toBe(true);
  });

  it('blocks creation and says why when API keys are switched off', () => {
    renderList({ enabled: false });
    expect(screen.getByRole('button', { name: 'New API key' })).toBeDisabled();
    expect(screen.getByText('API keys are turned off for this workspace.')).toBeInTheDocument();
  });
});
