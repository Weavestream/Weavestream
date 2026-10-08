/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../../../../components/ui';
import { ApiKeysSwitch } from './api-keys-switch';

const apiFetch = jest.fn();
const refresh = jest.fn();

jest.mock('../../../../lib/api', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
jest.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

function renderSwitch(enabled: boolean) {
  render(
    <ToastProvider>
      <ApiKeysSwitch enabled={enabled} />
    </ToastProvider>,
  );
  return screen.getByRole('checkbox', { name: /Allow API keys/ });
}

beforeEach(() => {
  apiFetch.mockReset();
  refresh.mockReset();
});

describe('ApiKeysSwitch', () => {
  it('saves through the dedicated step-up route', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: {} });
    const box = renderSwitch(false);
    await act(async () => {
      fireEvent.click(box);
    });
    expect(apiFetch).toHaveBeenCalledWith('/settings/api-keys', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    expect(box).toBeChecked();
    expect(refresh).toHaveBeenCalled();
  });

  it('stays unchanged and silent when the step-up prompt is dismissed', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, data: null, stepUpCancelled: true });
    const box = renderSwitch(false);
    await act(async () => {
      fireEvent.click(box);
    });
    expect(box).not.toBeChecked();
    expect(screen.queryByText(/Could not change/)).not.toBeInTheDocument();
  });
});
