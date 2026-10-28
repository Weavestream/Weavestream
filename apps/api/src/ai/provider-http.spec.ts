import {
  BACKGROUND_REASONING_HEADROOM,
  backgroundOutputBudget,
  claudeReasoningTier,
  outputTokenParam,
  providerAuthHeaders,
  reasoningParams,
  rejectsForcedToolChoice,
  supportsStrictTools,
  thinksAtLowest,
} from './provider-http.js';

const chat = (
  provider: 'openai' | 'anthropic' | 'openai_compatible',
  model: string | null,
  setting: 'off' | 'low' | 'medium' | 'high',
  maxTokens = 16_384,
) => reasoningParams({ provider, model, setting, purpose: 'chat', maxTokens });

describe('providerAuthHeaders', () => {
  it('uses Bearer for openai and openai_compatible', () => {
    expect(providerAuthHeaders({ provider: 'openai', apiKey: 'k', anthropicWorkspaceId: null })).toEqual(
      { Authorization: 'Bearer k' },
    );
    expect(
      providerAuthHeaders({ provider: 'openai_compatible', apiKey: null, anthropicWorkspaceId: null }),
    ).toEqual({});
  });

  it('never sends the workspace header to a non-Anthropic provider', () => {
    expect(
      providerAuthHeaders({ provider: 'openai', apiKey: 'k', anthropicWorkspaceId: 'wrkspc_1' }),
    ).toEqual({ Authorization: 'Bearer k' });
  });

  it('uses native auth for anthropic, with the workspace header when set', () => {
    expect(
      providerAuthHeaders({ provider: 'anthropic', apiKey: 'k', anthropicWorkspaceId: 'wrkspc_1' }),
    ).toEqual({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
      'anthropic-workspace-id': 'wrkspc_1',
    });
  });
});

describe('outputTokenParam', () => {
  it('uses max_completion_tokens on every OpenAI model', () => {
    expect(outputTokenParam('gpt-4o', 100, 'openai')).toEqual({ max_completion_tokens: 100 });
  });

  it('keeps max_tokens elsewhere, except the gpt-5 family', () => {
    expect(outputTokenParam('llama3', 100, 'openai_compatible')).toEqual({ max_tokens: 100 });
    expect(outputTokenParam('openai/gpt-5', 100)).toEqual({ max_tokens: 100 });
    expect(outputTokenParam('gpt-5-mini', 100)).toEqual({ max_completion_tokens: 100 });
  });
});

describe('reasoningParams — OpenAI', () => {
  it.each([
    ['gpt-5', 'minimal'],
    ['gpt-5-mini', 'minimal'],
    ['gpt-5-nano', 'minimal'],
    ['gpt-5.1', 'none'],
    ['gpt-5.2-pro', 'none'],
    ['o3', 'low'],
    ['o4-mini', 'low'],
  ])('%s off → reasoning_effort %s', (model, off) => {
    expect(chat('openai', model, 'off')).toEqual({ reasoning_effort: off });
  });

  it('passes low/medium/high through 1:1', () => {
    expect(chat('openai', 'gpt-5.1', 'medium')).toEqual({ reasoning_effort: 'medium' });
    expect(chat('openai', 'gpt-5', 'high')).toEqual({ reasoning_effort: 'high' });
  });

  it.each(['gpt-4o', 'gpt-4.1-mini', 'gpt-5-chat-latest', 'o1-mini', 'some-new-model'])(
    'sends nothing for %s (not a known reasoning model)',
    (model) => {
      expect(chat('openai', model, 'off')).toEqual({});
      expect(chat('openai', model, 'high')).toEqual({});
    },
  );

  it('background calls use the lowest setting whatever the admin chose', () => {
    expect(
      reasoningParams({
        provider: 'openai',
        model: 'gpt-5.1',
        setting: 'high',
        purpose: 'background',
        maxTokens: 512,
      }),
    ).toEqual({ reasoning_effort: 'none' });
  });
});

describe("reasoningParams — 'default' setting", () => {
  it.each([
    ['openai', 'gpt-5'],
    ['anthropic', 'claude-opus-5-5'],
    ['openai_compatible', 'qwen3'],
  ] as const)('%s chat sends nothing', (provider, model) => {
    expect(chat(provider, model, 'default' as never)).toEqual({});
  });

  it('background calls still use the lowest setting', () => {
    expect(
      reasoningParams({
        provider: 'openai',
        model: 'gpt-5',
        setting: 'default',
        purpose: 'background',
        maxTokens: 512,
      }),
    ).toEqual({ reasoning_effort: 'minimal' });
  });
});

describe('reasoningParams — openai_compatible (unchanged behavior)', () => {
  it('off sends the local-server disable flags', () => {
    expect(chat('openai_compatible', 'qwen3', 'off')).toEqual({
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
      reasoning: { effort: 'none' },
    });
  });

  it('any other setting sends no flags', () => {
    expect(chat('openai_compatible', 'qwen3', 'medium')).toEqual({});
  });
});

describe('reasoningParams — Anthropic', () => {
  it('maps model ids to the thinking tiers', () => {
    expect(claudeReasoningTier('claude-haiku-4-5')).toBe('budget');
    expect(claudeReasoningTier('claude-sonnet-4-5-20250929')).toBe('budget');
    expect(claudeReasoningTier('claude-sonnet-4-20250514')).toBe('budget');
    expect(claudeReasoningTier('claude-opus-4-7')).toBe('optin');
    expect(claudeReasoningTier('claude-sonnet-4-6')).toBe('optin');
    expect(claudeReasoningTier('claude-opus-5')).toBe('disableable');
    expect(claudeReasoningTier('claude-haiku-5-5')).toBe('disableable');
    expect(claudeReasoningTier('claude-opus-5-5')).toBe('always');
    expect(claudeReasoningTier('claude-fable-5-1')).toBe('always');
    expect(claudeReasoningTier('claude-mythos-preview')).toBe('always');
    expect(claudeReasoningTier('anthropic/claude-sonnet-5-5')).toBe('always');
    expect(claudeReasoningTier('claude-unknown-9')).toBeNull();
    expect(claudeReasoningTier('llama3')).toBeNull();
  });

  it('Opus 5.5 off → effort low, no thinking key', () => {
    expect(chat('anthropic', 'claude-opus-5-5', 'off')).toEqual({ output_config: { effort: 'low' } });
    expect(chat('anthropic', 'claude-opus-5-5', 'high')).toEqual({
      output_config: { effort: 'high' },
    });
  });

  it('Haiku 4.5: off → nothing; medium → budget_tokens and no effort', () => {
    expect(chat('anthropic', 'claude-haiku-4-5', 'off')).toEqual({});
    expect(chat('anthropic', 'claude-haiku-4-5', 'medium')).toEqual({
      thinking: { type: 'enabled', budget_tokens: 4_096 },
    });
  });

  it('keeps a thinking budget below max_tokens, and drops it below the 1024 floor', () => {
    expect(chat('anthropic', 'claude-haiku-4-5', 'high', 4_000)).toEqual({
      thinking: { type: 'enabled', budget_tokens: 3_999 },
    });
    expect(chat('anthropic', 'claude-haiku-4-5', 'low', 1_000)).toEqual({});
  });

  it('Opus 4.7: off → nothing; low → adaptive + effort', () => {
    expect(chat('anthropic', 'claude-opus-4-7', 'off')).toEqual({});
    expect(chat('anthropic', 'claude-opus-4-7', 'low')).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
    });
  });

  it('Opus 5: off → thinking disabled', () => {
    expect(chat('anthropic', 'claude-opus-5', 'off')).toEqual({ thinking: { type: 'disabled' } });
  });

  it('an unknown family gets nothing', () => {
    expect(chat('anthropic', 'claude-unknown-9', 'high')).toEqual({});
    expect(chat('anthropic', null, 'high')).toEqual({});
  });
});

describe('forced tool_choice and strict tools (Anthropic)', () => {
  it.each([
    ['claude-opus-5-5', true],
    ['claude-sonnet-5-5', true],
    ['claude-fable-5-1', true],
    ['claude-mythos-5-1', true],
    ['claude-opus-5', false],
    ['claude-fable-5', false],
    ['claude-haiku-5-5', false],
    ['claude-opus-4-7', false],
    ['gpt-5', false],
  ])('rejectsForcedToolChoice(%s) = %s', (model, expected) => {
    expect(rejectsForcedToolChoice(model)).toBe(expected);
  });

  it.each([
    ['claude-opus-5-5', true],
    ['claude-haiku-4-5', true],
    ['claude-opus-4-8', true],
    ['claude-fable-5-1', true],
    ['claude-sonnet-4-5', false],
    ['claude-opus-4-7', false],
    ['llama3', false],
  ])('supportsStrictTools(%s) = %s', (model, expected) => {
    expect(supportsStrictTools(model)).toBe(expected);
  });
});

describe('background budgets', () => {
  it('adds headroom only for models that think at their lowest setting', () => {
    expect(thinksAtLowest('openai', 'gpt-5')).toBe(true);
    expect(thinksAtLowest('openai', 'o3')).toBe(true);
    expect(thinksAtLowest('openai', 'gpt-5.1')).toBe(false);
    expect(thinksAtLowest('openai', 'gpt-4o')).toBe(false);
    expect(thinksAtLowest('anthropic', 'claude-opus-5-5')).toBe(true);
    expect(thinksAtLowest('anthropic', 'claude-opus-5')).toBe(false);
    expect(thinksAtLowest('openai_compatible', 'qwen3')).toBe(false);
  });

  it('caps the budget at half the context window', () => {
    const args = { provider: 'anthropic' as const, model: 'claude-opus-5-5', visible: 512 };
    expect(backgroundOutputBudget({ ...args, contextWindowTokens: 200_000 })).toBe(
      512 + BACKGROUND_REASONING_HEADROOM,
    );
    expect(backgroundOutputBudget({ ...args, contextWindowTokens: 4_096 })).toBe(2_048);
    expect(
      backgroundOutputBudget({ ...args, model: 'claude-opus-5', contextWindowTokens: 200_000 }),
    ).toBe(512);
  });
});
