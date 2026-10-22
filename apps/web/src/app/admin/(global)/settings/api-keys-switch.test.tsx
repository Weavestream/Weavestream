/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider } from '../../../../components/ui';
import { ApiKeysSwitch, McpClientPolicyChoice, McpRemoteSwitch } from './api-keys-switch';

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

describe('McpRemoteSwitch', () => {
  it('saves through its own step-up route', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: {} });
    render(
      <ToastProvider>
        <McpRemoteSwitch enabled={false} />
      </ToastProvider>,
    );
    const box = screen.getByRole('checkbox', { name: /Allow remote AI connections/ });
    await act(async () => {
      fireEvent.click(box);
    });
    expect(apiFetch).toHaveBeenCalledWith('/settings/mcp-remote', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    });
    expect(box).toBeChecked();
    expect(screen.getByRole('link', { name: 'Security center' })).toHaveAttribute(
      'href',
      '/admin/security?tab=ai-connections',
    );
  });
});

describe('AccessSwitch network failure', () => {
  it('keeps the switch as it was, unlocks it, and says the state is unknown', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    render(
      <ToastProvider>
        <McpRemoteSwitch enabled={false} />
      </ToastProvider>,
    );
    const box = screen.getByRole('checkbox', { name: /Allow remote AI connections/ });
    await act(async () => {
      fireEvent.click(box);
    });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/could not be reached; reload to see the current state/)).toBeInTheDocument();
    // Not stuck: a second attempt sends again.
    await act(async () => {
      fireEvent.click(box);
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});

describe('McpClientPolicyChoice', () => {
  function renderChoice(policy: 'claude_chatgpt' | 'any' = 'claude_chatgpt') {
    render(
      <ToastProvider>
        <McpClientPolicyChoice policy={policy} />
      </ToastProvider>,
    );
    return {
      narrow: screen.getByRole('radio', { name: /Claude and ChatGPT only/ }),
      any: screen.getByRole('radio', { name: /Any MCP app/ }),
    };
  }

  it('shows both choices with their help, the current one selected', () => {
    const { narrow, any } = renderChoice();
    expect(screen.getByText('Which AI apps can connect')).toBeInTheDocument();
    expect(narrow).toBeChecked();
    expect(any).not.toBeChecked();
    expect(screen.getByText(/Only claude.ai and ChatGPT on the web can connect/)).toBeInTheDocument();
    expect(screen.getByText(/Apps that register themselves are marked Not verified/)).toBeInTheDocument();
  });

  it.each([
    ['claude_chatgpt', 'any', /Any MCP app can now connect/],
    ['any', 'claude_chatgpt', /Only Claude and ChatGPT can connect now/],
  ] as const)('changes %s to %s through its own step-up route', async (from, to, toast) => {
    apiFetch.mockResolvedValue({ ok: true, status: 200, data: {} });
    const radios = renderChoice(from);
    await act(async () => {
      fireEvent.click(to === 'any' ? radios.any : radios.narrow);
    });
    expect(apiFetch).toHaveBeenCalledWith('/settings/mcp-client-policy', {
      method: 'PUT',
      body: JSON.stringify({ policy: to }),
    });
    expect(to === 'any' ? radios.any : radios.narrow).toBeChecked();
    expect(screen.getByText(toast)).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it('stays unchanged and silent when the step-up prompt is dismissed', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 403, data: null, stepUpCancelled: true });
    const { narrow, any } = renderChoice();
    await act(async () => {
      fireEvent.click(any);
    });
    expect(narrow).toBeChecked();
    expect(screen.queryByText(/Could not change/)).not.toBeInTheDocument();
  });

  it('keeps the choice and shows the server error', async () => {
    apiFetch.mockResolvedValue({
      ok: false,
      status: 403,
      data: null,
      problem: { title: 'Forbidden', detail: 'You do not have permission to change settings.' },
    });
    const { narrow } = renderChoice();
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: /Any MCP app/ }));
    });
    expect(narrow).toBeChecked();
    expect(screen.getByText('You do not have permission to change settings.')).toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('says the state is unknown when Weavestream cannot be reached, and can retry', async () => {
    apiFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    const { narrow, any } = renderChoice();
    await act(async () => {
      fireEvent.click(any);
    });
    expect(narrow).toBeChecked();
    expect(screen.getByText(/could not be reached; reload to see the current state/)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(any);
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not save when the current choice is clicked again', async () => {
    const { narrow } = renderChoice();
    await act(async () => {
      fireEvent.click(narrow);
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
