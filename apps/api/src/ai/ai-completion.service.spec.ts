jest.mock('../common/egress/safe-fetch.js', () => ({
  safeFetch: jest.fn(),
}));

import { safeFetch } from '../common/egress/safe-fetch.js';
import {
  AiCompletionHttpError,
  AiCompletionRefusedError,
  AiCompletionService,
  AiCompletionTruncatedError,
  describeCompletionHttpError,
  isContextLengthError,
  outputTokenParam,
  temperatureParam,
  sanitizeAiSummary,
  stripThinkTags,
} from './ai-completion.service.js';
import type { CompletionConfig } from './ai-completion.service.js';

const safeFetchMock = safeFetch as jest.Mock;

const CONFIG: CompletionConfig = {
  provider: 'openai_compatible',
  baseUrl: 'http://ollama.lan:11434/v1/',
  apiKey: null as string | null,
  anthropicWorkspaceId: null,
  allowPrivateNetwork: true,
};

const OPTS = {
  model: 'llama3',
  system: 'sys',
  user: 'usr',
  maxOutputTokens: 512,
  timeoutMs: 5_000,
};

function okResponse(message: Record<string, unknown>, finishReason?: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message, ...(finishReason ? { finish_reason: finishReason } : {}) }],
    }),
  };
}

function anthropicResponse(content: unknown[], stopReason: string) {
  return {
    ok: true,
    json: async () => ({ type: 'message', content, stop_reason: stopReason }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sanitizeAiSummary (§7 — model output is untrusted)', () => {
  it('strips think scratchpads, markdown, and control chars, and collapses whitespace', () => {
    const raw =
      '<think>attack\nplan</think># Heading\n\n**Bold** step\u0007 one\n\n- item';
    const out = sanitizeAiSummary(raw)!;
    expect(out).not.toMatch(/think|#|\*|\u0007/);
    expect(out).toContain('Bold step one');
    expect(out).not.toMatch(/\n/);
  });

  it('caps at the shared 280-char excerpt budget with a word-boundary ellipsis', () => {
    const out = sanitizeAiSummary('word '.repeat(200))!;
    expect(out.length).toBeLessThanOrEqual(280);
    expect(out.endsWith('…')).toBe(true);
  });

  it.each(['', '   ', '<think>only thoughts</think>'])(
    'returns null when nothing survives (%j)',
    (raw) => {
      expect(sanitizeAiSummary(raw)).toBeNull();
    },
  );
});

describe('temperatureParam', () => {
  it('omits temperature for models that reject a caller-supplied value', () => {
    for (const m of [
      'claude-haiku-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5',
      'claude-fable-5-1',
      // Claude 4.7+ already rejects temperature < 1.
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-mythos-preview',
      'claude-sonnet-6',
      'anthropic/claude-opus-4.7',
      'gpt-5-mini',
      'openai/gpt-5',
      'o3',
      'o4-mini',
    ]) {
      expect(temperatureParam(m, 0.2)).toEqual({});
    }
  });

  it('keeps temperature for everything else', () => {
    for (const m of [
      'claude-haiku-4-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      // Date snapshot, not version 4.20250514.
      'claude-sonnet-4-20250514',
      'claude-opus-4-1-20250805',
      'claude-3-5-sonnet',
      'gpt-4o',
      'llama3:latest',
    ]) {
      expect(temperatureParam(m, 0.2)).toEqual({ temperature: 0.2 });
    }
    expect(temperatureParam(null, 0.3)).toEqual({ temperature: 0.3 });
  });
});

describe('outputTokenParam / stripThinkTags (moved from chat-stream)', () => {
  it('keeps the gpt-5 rename quirk', () => {
    expect(outputTokenParam('gpt-5-mini', 100)).toEqual({
      max_completion_tokens: 100,
    });
    expect(outputTokenParam('llama3', 100)).toEqual({ max_tokens: 100 });
    expect(outputTokenParam(null, 100)).toEqual({ max_tokens: 100 });
  });

  it('strips multiple think blocks case-insensitively', () => {
    expect(stripThinkTags('<THINK>a</THINK>x<think>b</think>y')).toBe('xy');
  });

  // The pre-CodeQL-#38 implementation, kept as the behavioral oracle.
  const regexStrip = (raw: string) =>
    raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  it.each([
    'plain answer',
    '<think>a</think>',
    '  <think>a</think>  answer  ',
    '<think>unclosed answer',
    'stray </think> close',
    '</think><think>a</think>b',
    '<think>a<think>b</think>c</think>d',
    'a<think>b</think>c<think>d',
    '<think></think><Think>x</tHiNk>y',
    '<thinker>not a tag</thinker>',
  ])('matches the old regex on %j', (raw) => {
    expect(stripThinkTags(raw)).toBe(regexStrip(raw));
  });

  it('stays linear on many unclosed <think> tags', () => {
    const raw = '<think>'.repeat(200_000) + 'tail';
    const start = Date.now();
    expect(stripThinkTags(raw)).toBe(raw);
    expect(Date.now() - start).toBeLessThan(1_000);
  });
});

describe('isContextLengthError', () => {
  it.each([
    'maximum context length exceeded',
    "This model's maximum context length is 4096 tokens",
    'too many tokens in prompt',
    'prompt is too long for the model',
    'token limit reached',
  ])('classifies a 400 with %j', (body) => {
    expect(isContextLengthError(new AiCompletionHttpError(400, body))).toBe(true);
  });

  it('rejects 5xx, unrelated 400s, and non-http errors', () => {
    expect(
      isContextLengthError(new AiCompletionHttpError(503, 'context busy')),
    ).toBe(false);
    expect(
      isContextLengthError(new AiCompletionHttpError(400, 'invalid api key')),
    ).toBe(false);
    expect(isContextLengthError(new Error('context'))).toBe(false);
  });
});

describe('describeCompletionHttpError (§6 — logs get a classification, never the body)', () => {
  it.each([
    [400, 'maximum context length exceeded', '400 context-length'],
    [
      400,
      '{"error":{"message":"Unrecognized request argument supplied: enable_thinking"}}',
      "400 rejected-parameter 'enable_thinking'",
    ],
    [
      400,
      "Unsupported value: 'temperature' does not support 0.3 with this model.",
      "400 rejected-parameter 'temperature'",
    ],
    [
      400,
      "Unsupported value: 'reasoning.effort' is not valid",
      "400 rejected-parameter 'reasoning'",
    ],
    [401, 'invalid api key', '401 auth'],
    [404, 'no such route', '404 not-found'],
    [429, 'slow down', '429 rate-limit-or-quota'],
    [400, 'insufficient quota for this billing period', '400 rate-limit-or-quota'],
    [400, 'the model `nope` does not exist', '400 model-rejected'],
  ])('classifies %i %j as %j', (status, body, expected) => {
    expect(
      describeCompletionHttpError(new AiCompletionHttpError(status, body)),
    ).toBe(expected);
  });

  it('an unrecognized body is reduced to length + fingerprint — not one byte of the text survives', () => {
    const body = 'Article says: reboot the switch at 3pm using password hunter2';
    const out = describeCompletionHttpError(new AiCompletionHttpError(400, body));
    expect(out).toMatch(/^400 unclassified \(\d+ chars, sha256:[0-9a-f]{12}\)$/);
    for (const word of body.split(' ')) {
      expect(out).not.toContain(word);
    }
  });

  it('a parameter-shaped capture outside the sent-params allowlist is never echoed', () => {
    // A provider (or something impersonating one) could put arbitrary
    // text where the parameter name goes — only names we actually send
    // may reach a log line.
    const out = describeCompletionHttpError(
      new AiCompletionHttpError(
        400,
        'Unrecognized request argument supplied: leaked_prompt_fragment_here',
      ),
    );
    expect(out).not.toContain('leaked_prompt_fragment_here');
    expect(out).toMatch(/^400 unclassified /);
  });
});

describe('AiCompletionService.complete', () => {
  it('returns trimmed content and sends the reasoning-suppression flags', async () => {
    safeFetchMock.mockResolvedValue(okResponse({ content: '  A summary. ' }));
    const svc = new AiCompletionService();
    const out = await svc.complete(CONFIG, OPTS);
    expect(out).toBe('A summary.');

    const [url, init] = safeFetchMock.mock.calls[0]!;
    expect(url).toBe('http://ollama.lan:11434/v1/chat/completions');
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(false);
    expect(body.enable_thinking).toBe(false);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.max_tokens).toBe(512);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it('sends the bearer header only when a key is configured', async () => {
    safeFetchMock.mockResolvedValue(okResponse({ content: 'x' }));
    const svc = new AiCompletionService();
    await svc.complete({ ...CONFIG, apiKey: 'sk-test' }, OPTS);
    expect(safeFetchMock.mock.calls[0]![1].headers.Authorization).toBe(
      'Bearer sk-test',
    );
  });

  it('falls back across the reasoning response shapes', async () => {
    safeFetchMock.mockResolvedValue(
      okResponse({ content: '', reasoning_content: 'from reasoning' }),
    );
    const svc = new AiCompletionService();
    expect(await svc.complete(CONFIG, OPTS)).toBe('from reasoning');
  });

  it('returns null on a well-formed response with no usable content (never retry-worthy)', async () => {
    safeFetchMock.mockResolvedValue(okResponse({ content: '' }));
    const svc = new AiCompletionService();
    expect(await svc.complete(CONFIG, OPTS)).toBeNull();
  });

  it('throws AiCompletionHttpError with a bounded snippet on non-2xx (retryable via BullMQ)', async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited '.repeat(100),
    });
    const svc = new AiCompletionService();
    const err = await svc.complete(CONFIG, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(AiCompletionHttpError);
    expect((err as AiCompletionHttpError).status).toBe(429);
    expect((err as AiCompletionHttpError).bodySnippet.length).toBeLessThanOrEqual(500);
  });

  it('propagates transport failures from safeFetch', async () => {
    safeFetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const svc = new AiCompletionService();
    await expect(svc.complete(CONFIG, OPTS)).rejects.toThrow('ECONNREFUSED');
  });

  it('retries a strict-endpoint param rejection once with a minimal OpenAI-safe body', async () => {
    // Real OpenAI 400s on unrecognized arguments; gpt-5-family also
    // rejects non-default temperature. Local servers ignore extras.
    safeFetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () =>
          '{"error":{"message":"Unrecognized request argument supplied: enable_thinking"}}',
      })
      .mockResolvedValueOnce(okResponse({ content: 'Second try works.' }));
    const svc = new AiCompletionService();
    expect(await svc.complete(CONFIG, OPTS)).toBe('Second try works.');

    expect(safeFetchMock).toHaveBeenCalledTimes(2);
    const full = JSON.parse(safeFetchMock.mock.calls[0]![1].body);
    const minimal = JSON.parse(safeFetchMock.mock.calls[1]![1].body);
    expect(full.enable_thinking).toBe(false);
    expect(full.temperature).toBe(0.3);
    for (const k of [
      'temperature',
      'enable_thinking',
      'chat_template_kwargs',
      'reasoning',
    ]) {
      expect(minimal).not.toHaveProperty(k);
    }
    expect(minimal.model).toBe('llama3');
    expect(minimal.max_tokens).toBe(512);
    expect(minimal.messages).toEqual(full.messages);
  });

  it('does not strict-retry a context-length 400 — the caller owns input halving', async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'maximum context length exceeded',
    });
    const svc = new AiCompletionService();
    const err = await svc.complete(CONFIG, OPTS).catch((e) => e);
    expect(isContextLengthError(err)).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 400 that persists on the minimal body still throws (no retry loop)', async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":{"message":"model not found"}}',
    });
    const svc = new AiCompletionService();
    await expect(svc.complete(CONFIG, OPTS)).rejects.toBeInstanceOf(
      AiCompletionHttpError,
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(2);
  });

  it('redacts secret shapes in the error body at capture, before anything can rethrow it', async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        'Invalid key sk-proj-abcdef1234567890 for Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    });
    const svc = new AiCompletionService();
    const err = (await svc.complete(CONFIG, OPTS).catch((e) => e)) as AiCompletionHttpError;
    expect(err).toBeInstanceOf(AiCompletionHttpError);
    expect(err.bodySnippet).not.toContain('sk-proj-abcdef1234567890');
    expect(err.bodySnippet).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(err.bodySnippet).toContain('sk-[redacted]');
    expect(err.bodySnippet).toContain('Bearer [redacted]');
  });

  it('contentOnly takes message.content but never the reasoning shapes', async () => {
    const svc = new AiCompletionService();
    safeFetchMock.mockResolvedValueOnce(
      okResponse({ content: ' visible ', reasoning_content: 'cot' }),
    );
    expect(await svc.complete(CONFIG, { ...OPTS, contentOnly: true })).toBe(
      'visible',
    );
    // Reasoning-only response: a fallback here would render
    // chain-of-thought verbatim in the chat transcript.
    safeFetchMock.mockResolvedValueOnce(
      okResponse({ content: '', reasoning_content: 'from reasoning' }),
    );
    expect(
      await svc.complete(CONFIG, { ...OPTS, contentOnly: true }),
    ).toBeNull();
  });

  it('an external signal abort cancels the in-flight request and never strict-retries', async () => {
    const external = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    safeFetchMock.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          fetchSignal = init.signal;
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
          external.abort();
        }),
    );
    const svc = new AiCompletionService();
    await expect(
      svc.complete(CONFIG, { ...OPTS, signal: external.signal }),
    ).rejects.toThrow('aborted');
    // The abort reached the request's own controller, and an
    // AbortError is not a 400 — exactly one upstream call.
    expect(fetchSignal?.aborted).toBe(true);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('AiCompletionService — finish reasons', () => {
  it('a thinking-only reply cut off by the token cap throws AiCompletionTruncatedError', async () => {
    safeFetchMock.mockResolvedValue(okResponse({ content: '' }, 'length'));
    const err = await new AiCompletionService().complete(CONFIG, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(AiCompletionTruncatedError);
    // Not a 400: the strict-endpoint retry does not run.
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });

  it('a refusal throws AiCompletionRefusedError', async () => {
    safeFetchMock.mockResolvedValueOnce(okResponse({ content: '', refusal: 'No.' }));
    await expect(new AiCompletionService().complete(CONFIG, OPTS)).rejects.toBeInstanceOf(
      AiCompletionRefusedError,
    );
    safeFetchMock.mockResolvedValueOnce(okResponse({ content: '' }, 'content_filter'));
    await expect(new AiCompletionService().complete(CONFIG, OPTS)).rejects.toBeInstanceOf(
      AiCompletionRefusedError,
    );
  });

  it('a well-formed empty reply that stopped normally is still null', async () => {
    safeFetchMock.mockResolvedValue(okResponse({ content: '' }, 'stop'));
    expect(await new AiCompletionService().complete(CONFIG, OPTS)).toBeNull();
  });

  it('a length cut-off with only reasoning fields throws truncated, never returns the reasoning', async () => {
    safeFetchMock.mockResolvedValue(
      okResponse({ content: null, reasoning_content: 'First, I should consider' }, 'length'),
    );
    await expect(new AiCompletionService().complete(CONFIG, OPTS)).rejects.toBeInstanceOf(
      AiCompletionTruncatedError,
    );
  });

  it.each([
    ['a closed <think> block', '<think>planning the summary</think>'],
    ['an unclosed <think> block', '<think>planning the summary, step one is'],
  ])('content with only %s and a length finish throws truncated', async (_label, content) => {
    safeFetchMock.mockResolvedValue(okResponse({ content }, 'length'));
    await expect(new AiCompletionService().complete(CONFIG, OPTS)).rejects.toBeInstanceOf(
      AiCompletionTruncatedError,
    );
  });

  it('an unclosed <think> after visible text is dropped from the result', async () => {
    safeFetchMock.mockResolvedValue(okResponse({ content: 'Answer. <think>more' }, 'length'));
    expect(await new AiCompletionService().complete(CONFIG, OPTS)).toBe('Answer.');
  });

  it('a finished reply with only a reasoning field still uses the fallback', async () => {
    safeFetchMock.mockResolvedValue(
      okResponse({ content: '<think>x</think>', reasoning_content: 'The title' }, 'stop'),
    );
    expect(await new AiCompletionService().complete(CONFIG, OPTS)).toBe('The title');
  });

  it('visible text wins over a length finish', async () => {
    safeFetchMock.mockResolvedValue(okResponse({ content: 'Partial.' }, 'length'));
    expect(await new AiCompletionService().complete(CONFIG, OPTS)).toBe('Partial.');
  });
});

describe('AiCompletionService — provider openai', () => {
  it('sends max_completion_tokens and reasoning_effort, never the local-server flags', async () => {
    safeFetchMock.mockResolvedValue(okResponse({ content: 'x' }));
    await new AiCompletionService().complete(
      { ...CONFIG, provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
      { ...OPTS, model: 'gpt-5.1' },
    );
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1].body);
    expect(body.max_completion_tokens).toBe(512);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.reasoning_effort).toBe('none');
    for (const k of ['enable_thinking', 'chat_template_kwargs', 'reasoning', 'temperature']) {
      expect(body).not.toHaveProperty(k);
    }
  });
});

describe('AiCompletionService — provider anthropic (native Messages API)', () => {
  const ANTHROPIC: CompletionConfig = {
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1/',
    apiKey: 'sk-ant-test',
    anthropicWorkspaceId: 'wrkspc_01',
    allowPrivateNetwork: false,
  };

  it('posts /messages with native auth, a top-level system and no temperature', async () => {
    safeFetchMock.mockResolvedValue(
      anthropicResponse([{ type: 'text', text: ' Hello ' }], 'end_turn'),
    );
    const out = await new AiCompletionService().complete(ANTHROPIC, {
      ...OPTS,
      model: 'claude-opus-5-5',
      temperature: 0.3,
    });
    expect(out).toBe('Hello');
    const [url, init] = safeFetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-api-key': 'sk-ant-test',
      'anthropic-version': '2023-06-01',
      'anthropic-workspace-id': 'wrkspc_01',
    });
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 512,
      system: 'sys',
      messages: [{ role: 'user', content: 'usr' }],
      // Opus 5.5 always thinks; background calls use the lowest effort.
      output_config: { effort: 'low' },
    });
  });

  it('turns thinking off where the model allows it', async () => {
    safeFetchMock.mockResolvedValue(anthropicResponse([{ type: 'text', text: 'x' }], 'end_turn'));
    await new AiCompletionService().complete(ANTHROPIC, { ...OPTS, model: 'claude-opus-5' });
    const body = JSON.parse(safeFetchMock.mock.calls[0]![1].body);
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body).not.toHaveProperty('output_config');
  });

  it('reads only text blocks, never thinking', async () => {
    safeFetchMock.mockResolvedValue(
      anthropicResponse(
        [
          { type: 'thinking', thinking: 'secret plan', signature: 'sig' },
          { type: 'text', text: 'Answer' },
        ],
        'end_turn',
      ),
    );
    expect(
      await new AiCompletionService().complete(ANTHROPIC, { ...OPTS, model: 'claude-opus-5-5' }),
    ).toBe('Answer');
  });

  it('maps refusal and a thinking-only max_tokens stop to the typed errors', async () => {
    const svc = new AiCompletionService();
    safeFetchMock.mockResolvedValueOnce(anthropicResponse([], 'refusal'));
    await expect(svc.complete(ANTHROPIC, OPTS)).rejects.toBeInstanceOf(AiCompletionRefusedError);
    safeFetchMock.mockResolvedValueOnce(
      anthropicResponse([{ type: 'thinking', thinking: '', signature: 's' }], 'max_tokens'),
    );
    await expect(svc.complete(ANTHROPIC, OPTS)).rejects.toBeInstanceOf(AiCompletionTruncatedError);
  });

  it('does not run the strict-endpoint retry on a 400', async () => {
    safeFetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"type":"error","error":{"type":"invalid_request_error"}}',
    });
    await expect(new AiCompletionService().complete(ANTHROPIC, OPTS)).rejects.toBeInstanceOf(
      AiCompletionHttpError,
    );
    expect(safeFetchMock).toHaveBeenCalledTimes(1);
  });
});
