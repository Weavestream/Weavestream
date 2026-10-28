/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { randomUUID } from 'node:crypto';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AiSettings } from '@weavestream/shared';
import { ToastProvider } from '../../../../components/ui';
import { AiSettingsForm } from './ai-settings-form';

const apiFetch = jest.fn();
jest.mock('../../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
jest.mock('./ai-settings-form.module.css', () => ({}));

const INITIAL: AiSettings = {
  enabled: true,
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  defaultModel: 'model-primary',
  backgroundModel: null,
  reasoningEffort: 'default',
  anthropicWorkspaceId: null,
  apiKeyConfigured: true,
  maxOutputTokens: null,
  contextWindowTokens: null,
  allowPrivateNetwork: false,
  autoSummaries: false,
  updatedAt: '2026-10-28T12:00:00Z',
};

function renderForm(overrides: Partial<AiSettings> = {}) {
  render(
    <ToastProvider>
      <AiSettingsForm initial={{ ...INITIAL, ...overrides }} />
    </ToastProvider>,
  );
}

async function clickAction(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

function lastPayload() {
  return JSON.parse(apiFetch.mock.calls.at(-1)![1].body);
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (path: string, options: { body: string }) => {
    const payload = JSON.parse(options.body);
    return {
      ok: true,
      data:
        path === '/settings/ai'
          ? { ...INITIAL, ...payload, apiKeyConfigured: !payload.clearApiKey }
          : { models: [{ id: 'model-primary' }], probe: { status: 'ok' } },
    };
  });
});

describe('AI settings endpoints', () => {
  it('uses the OpenAI default for testing without an endpoint input', async () => {
    renderForm();
    expect(screen.queryByLabelText('Endpoint URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Custom endpoint URL')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
    await clickAction('Test connection');
    expect(lastPayload()).toMatchObject({ provider: 'openai', baseUrl: INITIAL.baseUrl });
    expect(lastPayload()).not.toHaveProperty('apiKey');
    expect(screen.getByText('Test reply OK.')).toBeInTheDocument();
  });

  it('switches hosted providers to their own default and saves it with a new key', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('radio', { name: /^Anthropic/ }));
    expect(screen.getByText('https://api.anthropic.com/v1')).toBeInTheDocument();
    expect(screen.getByLabelText('Default model')).toHaveValue('');
    expect(screen.getByLabelText('Background model')).toHaveValue('');
    await clickAction('Replace key');
    fireEvent.change(screen.getByLabelText('New API key'), { target: { value: randomUUID() } });
    await clickAction('Test connection');
    expect(lastPayload()).toMatchObject({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
    });
    await clickAction('Save AI settings');
    expect(lastPayload()).toMatchObject({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      autoSummaries: false,
    });
    expect(lastPayload()).toHaveProperty('apiKey');
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
  });

  it('keeps an existing custom URL visible and preserves it across provider switches', async () => {
    const customUrl = 'https://gateway.example/v1';
    renderForm({ baseUrl: customUrl });
    expect(screen.getByLabelText('Custom endpoint URL')).toBeVisible();
    expect(screen.getByLabelText(/^Use a custom endpoint/)).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: /^Anthropic/ }));
    expect(screen.getByText('https://api.anthropic.com/v1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /^OpenAI Connect/ }));
    expect(screen.getByLabelText('Custom endpoint URL')).toHaveValue(customUrl);
    await clickAction('Test connection');
    expect(lastPayload().baseUrl).toBe(customUrl);
  });

  it('turns off an override without losing the draft and resets to the saved custom URL', async () => {
    const customUrl = 'https://gateway.example/v1';
    renderForm({ baseUrl: customUrl });
    fireEvent.click(screen.getByLabelText(/^Use a custom endpoint/));
    await clickAction('Test connection');
    expect(lastPayload().baseUrl).toBe(INITIAL.baseUrl);
    fireEvent.click(screen.getByLabelText(/^Use a custom endpoint/));
    expect(screen.getByLabelText('Custom endpoint URL')).toHaveValue(customUrl);
    fireEvent.change(screen.getByLabelText('Custom endpoint URL'), {
      target: { value: 'https://other.example/v1' },
    });
    await clickAction('Reset');
    expect(screen.getByLabelText('Custom endpoint URL')).toHaveValue(customUrl);
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
  });

  it('requires an explicit endpoint for compatible servers', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('radio', { name: /^OpenAI-compatible/ }));
    expect(screen.getByLabelText('Endpoint URL')).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Connection' })).getByRole('checkbox', {
        name: /^Allow private-network addresses/,
      }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Endpoint URL'), {
      target: { value: 'http://localhost:11434/v1' },
    });
    await clickAction('Test connection');
    expect(lastPayload()).toMatchObject({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:11434/v1',
      allowPrivateNetwork: false,
    });
  });
});

it('recognizes a saved default URL with a trailing slash without changing it on load', () => {
  renderForm({ baseUrl: `${INITIAL.baseUrl}/` });
  expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
  expect(screen.queryByLabelText('Custom endpoint URL')).not.toBeInTheDocument();
});

describe('AI settings credentials and connection feedback', () => {
  it('keeps an existing private-network opt-in visible for hosted providers and allows it to be disabled', async () => {
    renderForm({ allowPrivateNetwork: true });
    const network = within(screen.getByRole('region', { name: 'Connection' })).getByRole(
      'checkbox',
      { name: /^Allow private-network addresses/ },
    );
    expect(network).toBeVisible();
    expect(network).toBeChecked();
    expect(screen.getByText(/This relaxes server-side request protections/)).toBeVisible();
    fireEvent.click(network);
    await clickAction('Save AI settings');
    expect(lastPayload().allowPrivateNetwork).toBe(false);
  });

  it('stages key removal, prevents testing with the old key, and allows undo', async () => {
    renderForm();
    await clickAction('Remove key');
    expect(screen.getByText('Removal pending')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(apiFetch).not.toHaveBeenCalled();
    await clickAction('Undo removal');
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
    await clickAction('Remove key');
    await clickAction('Save AI settings');
    expect(lastPayload()).toMatchObject({ clearApiKey: true });
    expect(lastPayload()).not.toHaveProperty('apiKey');
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
  });

  it('clears an unsaved replacement key when switching providers', async () => {
    renderForm();
    await clickAction('Replace key');
    fireEvent.change(screen.getByLabelText('New API key'), { target: { value: randomUUID() } });
    fireEvent.click(screen.getByRole('radio', { name: /^Anthropic/ }));
    await clickAction('Test connection');
    expect(lastPayload()).not.toHaveProperty('apiKey');
  });

  it('uses a replacement key for testing and saves it without sending a removal flag', async () => {
    renderForm();
    const replacementKey = randomUUID();
    await clickAction('Replace key');
    fireEvent.change(screen.getByLabelText('New API key'), { target: { value: replacementKey } });
    await clickAction('Test connection');
    expect(lastPayload().apiKey).toBe(replacementKey);
    await clickAction('Save AI settings');
    expect(lastPayload().apiKey).toBe(replacementKey);
    expect(lastPayload()).not.toHaveProperty('clearApiKey');
    expect(screen.queryByLabelText('New API key')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
  });

  it('distinguishes discovered models from a failed reply and invalidates the reply when the model changes', async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        models: [{ id: 'model-primary' }, { id: 'model-other' }],
        probe: { status: 'failed', reason: 'timeout' },
      },
    });
    renderForm();
    await clickAction('Test connection');
    expect(screen.getByText('2 models found')).toBeInTheDocument();
    expect(screen.getByText('The model did not reply in time.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Default model'), { target: { value: 'model-other' } });
    expect(screen.queryByText('The model did not reply in time.')).not.toBeInTheDocument();
    expect(screen.getByText('2 models found')).toBeInTheDocument();
  });

  it('invalidates discovered models after changing the endpoint', async () => {
    renderForm({ baseUrl: 'https://gateway.example/v1' });
    await clickAction('Test connection');
    expect(screen.getByRole('combobox', { name: 'Default model' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Custom endpoint URL'), {
      target: { value: 'https://other.example/v1' },
    });
    expect(screen.queryByText('1 model found')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Default model' })).toHaveValue('model-primary');
  });
});

describe('AI settings saved key on a new endpoint', () => {
  it('blocks saving until the new endpoint has its own key or the saved key is removed', async () => {
    renderForm();
    fireEvent.click(screen.getByRole('radio', { name: /^Anthropic/ }));
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
    expect(screen.getByText(/The endpoint has changed/)).toBeVisible();
    expect(
      screen.getByText('Enter a key for the new endpoint, or remove the saved key.'),
    ).toBeInTheDocument();
    await clickAction('Remove key');
    expect(screen.queryByText(/The endpoint has changed/)).not.toBeInTheDocument();
    await clickAction('Save AI settings');
    expect(lastPayload()).toMatchObject({
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      clearApiKey: true,
    });
  });

  it('does not block a trailing-slash change to the same endpoint', async () => {
    renderForm({ baseUrl: 'https://gateway.example/v1' });
    fireEvent.change(screen.getByLabelText('Custom endpoint URL'), {
      target: { value: 'https://gateway.example/v1/' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /^Automatic article summaries/ }));
    expect(screen.queryByText(/The endpoint has changed/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeEnabled();
  });
});

describe('AI token sliders', () => {
  it('shows the 16k output default without a reasoning warning and preserves default values on save', async () => {
    renderForm();
    expect(screen.queryByText('Review settings')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Advanced', { exact: true }));
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveAttribute(
      'aria-valuetext',
      '16,384 tokens (default)',
    );
    expect(screen.getByRole('slider', { name: 'Context window tokens' })).toHaveAttribute(
      'aria-valuetext',
      '32,768 tokens (default)',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /^Automatic article summaries/ }));
    await clickAction('Save AI settings');
    expect(lastPayload()).toMatchObject({ maxOutputTokens: null, contextWindowTokens: null });
  });

  it('saves token values selected with sliders and can restore the default', async () => {
    renderForm();
    fireEvent.click(screen.getByText('Advanced', { exact: true }));
    const output = screen.getByRole('slider', { name: 'Max output tokens' }) as HTMLInputElement;
    const context = screen.getByRole('slider', {
      name: 'Context window tokens',
    }) as HTMLInputElement;
    fireEvent.change(output, { target: { value: Number(output.value) + 1 } });
    fireEvent.change(context, { target: { value: Number(context.value) + 1 } });
    expect(output).toHaveAttribute('aria-valuetext', '32,768 tokens');
    expect(context).toHaveAttribute('aria-valuetext', '65,536 tokens');
    await clickAction('Save AI settings');
    expect(lastPayload()).toMatchObject({ maxOutputTokens: 32_768, contextWindowTokens: 65_536 });
    await clickAction('Use default for Max output tokens');
    await clickAction('Save AI settings');
    expect(lastPayload().maxOutputTokens).toBeNull();
    expect(output).toHaveAttribute('aria-valuetext', '16,384 tokens (default)');
  });

  it('preserves a saved custom value between slider stops', async () => {
    renderForm({ maxOutputTokens: 5_000, contextWindowTokens: 90_000 });
    fireEvent.click(screen.getByText('Advanced', { exact: true }));
    expect(screen.getByRole('slider', { name: 'Max output tokens' })).toHaveAttribute(
      'aria-valuetext',
      '5,000 tokens',
    );
    expect(screen.getByRole('slider', { name: 'Context window tokens' })).toHaveAttribute(
      'aria-valuetext',
      '90,000 tokens',
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /^Automatic article summaries/ }));
    await clickAction('Save AI settings');
    expect(lastPayload()).toMatchObject({ maxOutputTokens: 5_000, contextWindowTokens: 90_000 });
  });

  it('blocks saving when the output limit reaches the context window', async () => {
    renderForm({ maxOutputTokens: 8_192, contextWindowTokens: 16_384 });
    fireEvent.click(screen.getByText('Advanced', { exact: true }));
    const output = screen.getByRole('slider', { name: 'Max output tokens' }) as HTMLInputElement;
    fireEvent.change(output, { target: { value: Number(output.value) + 1 } });
    expect(output).toHaveAttribute('aria-valuetext', '16,384 tokens');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Max output tokens must be less than the context window.',
    );
    expect(screen.getByText('Review settings')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save AI settings' })).toBeDisabled();
  });

  it('shows the server cap and warns when the cap leaves a small reasoning budget', () => {
    renderForm({ contextWindowTokens: 16_384 });
    expect(screen.getByText('Review settings')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Advanced', { exact: true }));
    expect(
      screen.getByText('Replies are capped at 8,192 tokens, half the context window.'),
    ).toBeVisible();
    expect(screen.getByText(/Reasoning models use output tokens for thinking/)).toBeVisible();
  });
});
