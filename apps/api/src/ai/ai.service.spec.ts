import { BadRequestException } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { AiCompletionService } from './ai-completion.service.js';
import type { AiResolvedConfig } from './ai-settings.service.js';
import {
  resetEgressGuardForTests,
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../common/egress/safe-fetch.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

const ACTOR: AuthedUser = {
  id: 'actor-1',
  role: 'SUPER_ADMIN',
  globalAccess: null,
  platformCapabilities: [],
  email: 'admin@example.com',
  sessionId: 's-1',
  mfaEnforcementCompletedAt: new Date(),
  mfaPending: false,
};

const META = { ip: '127.0.0.1', userAgent: 'jest' };

const MODELS_BODY = JSON.stringify({ data: [{ id: 'llama3:latest' }] });

function resolvedConfig(overrides: Partial<AiResolvedConfig> = {}): AiResolvedConfig {
  return {
    provider: 'openai_compatible',
    baseUrl: 'http://ollama.lan:11434/v1',
    apiKey: null,
    defaultModel: 'llama3:latest',
    backgroundModel: 'llama3:latest',
    reasoningEffort: 'off',
    anthropicWorkspaceId: null,
    maxOutputTokens: 8_192,
    contextWindowTokens: 32_768,
    allowPrivateNetwork: false,
    ...overrides,
  };
}

function makeSettings(config: AiResolvedConfig) {
  return {
    getConfig: jest.fn().mockResolvedValue(config),
    getRawConfig: jest.fn().mockResolvedValue(config),
  };
}

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makeService(config: AiResolvedConfig) {
  const settings = makeSettings(config);
  const audit = makeAudit();
  const svc = new AiService(settings as never, audit as never, new AiCompletionService());
  return { svc, settings, audit };
}

describe('AiService — private-network opt-in (WS-017)', () => {
  beforeEach(() => {
    // The endpoint hostname resolves to a LAN address in every test; what
    // varies is whether the opt-in allows it through.
    setDefaultResolveForTests(async () => ['192.168.1.50']);
    setDefaultFetchForTests(
      (() =>
        Promise.resolve(new Response(MODELS_BODY, { status: 200 }))) as unknown as typeof fetch,
    );
  });

  afterEach(() => resetEgressGuardForTests());

  it('blocks a private endpoint when the opt-in is off, with an actionable hint', async () => {
    const { svc } = makeService(resolvedConfig({ allowPrivateNetwork: false }));
    await expect(svc.listModels()).rejects.toThrow(
      /not allowed.*Allow private-network addresses/s,
    );
  });

  it('reaches a private endpoint when the opt-in is on', async () => {
    const { svc } = makeService(resolvedConfig({ allowPrivateNetwork: true }));
    await expect(svc.listModels()).resolves.toEqual([{ id: 'llama3:latest' }]);
  });

  it('honours an unsaved checkbox: allowPrivateNetwork-only override enters override mode', async () => {
    // Saved config has the opt-in OFF; the test request carries only the
    // checkbox. It must be treated as an override against the saved
    // baseUrl instead of falling through to the saved (blocked) config.
    const { svc, settings } = makeService(
      resolvedConfig({ allowPrivateNetwork: false }),
    );
    await expect(
      svc.listModels({ allowPrivateNetwork: true }),
    ).resolves.toEqual([{ id: 'llama3:latest' }]);
    // Override path never enforces `enabled`, so it reads the raw config.
    expect(settings.getRawConfig).toHaveBeenCalled();
    expect(settings.getConfig).not.toHaveBeenCalled();
  });

  it('redacts secrets from upstream error bodies and caps the snippet', async () => {
    setDefaultFetchForTests(
      (() =>
        Promise.resolve(
          new Response(
            `{"error":"invalid key","api_key":"sk-verysecret1234567890"} ${'x'.repeat(500)}`,
            { status: 401 },
          ),
        )) as unknown as typeof fetch,
    );
    const { svc } = makeService(resolvedConfig({ allowPrivateNetwork: true }));
    const err = await svc.listModels().then(
      () => null,
      (e: unknown) => e as BadRequestException,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err!.message).toContain('401');
    expect(err!.message).toContain('[redacted]');
    expect(err!.message).not.toContain('verysecret');
    // Status line + redacted URL + 200-char snippet, nowhere near the old
    // unbounded body echo.
    expect(err!.message.length).toBeLessThan(400);
  });

  it('never echoes userinfo or query secrets from the configured base URL', async () => {
    setDefaultFetchForTests(
      (() =>
        Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch,
    );
    const { svc } = makeService(
      resolvedConfig({
        baseUrl: 'http://admin:hunter2@ollama.lan:11434/v1?key=qsecret',
        allowPrivateNetwork: true,
      }),
    );
    const err = await svc.listModels().then(
      () => null,
      (e: unknown) => e as BadRequestException,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err!.message).not.toContain('hunter2');
    expect(err!.message).not.toContain('qsecret');
  });

  describe('runTest audit', () => {
    it('records privateNetworkAllowed and overrideUsed without any secrets', async () => {
      const { svc, audit } = makeService(
        resolvedConfig({ allowPrivateNetwork: false }),
      );
      await expect(
        svc.runTest(ACTOR, META, {
          apiKey: 'sk-testkey12345',
          allowPrivateNetwork: true,
        }),
      ).resolves.toEqual({
        ok: true,
        models: [{ id: 'llama3:latest' }],
        probe: { status: 'skipped', reason: 'no-model' },
      });

      expect(audit.log).toHaveBeenCalledTimes(1);
      const entry = audit.log.mock.calls[0]![0];
      expect(entry.action).toBe('settings.ai.test');
      expect(entry.after).toEqual(
        expect.objectContaining({
          success: true,
          modelCount: 1,
          privateNetworkAllowed: true,
          overrideUsed: true,
        }),
      );
      expect(JSON.stringify(entry)).not.toContain('sk-testkey12345');
    });

    it('records the applied flag and redacted error on a blocked test', async () => {
      const { svc, audit } = makeService(
        resolvedConfig({ allowPrivateNetwork: false }),
      );
      await expect(svc.runTest(ACTOR, META)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      const entry = audit.log.mock.calls[0]![0];
      expect(entry.after).toEqual(
        expect.objectContaining({
          success: false,
          privateNetworkAllowed: false,
          overrideUsed: false,
        }),
      );
      expect(typeof entry.after.error).toBe('string');
    });
  });
});

describe('AiService — saved key is bound to the saved endpoint', () => {
  const SAVED_KEY = 'sk-SAVED-PROVIDER-SECRET';
  let seen: Array<{ url: string; auth: string | null }>;

  beforeEach(() => {
    seen = [];
    setDefaultResolveForTests(async () => ['93.184.216.34']);
    setDefaultFetchForTests(((url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push({ url: String(url), auth: headers.Authorization ?? null });
      return Promise.resolve(new Response(MODELS_BODY, { status: 200 }));
    }) as unknown as typeof fetch);
  });

  afterEach(() => resetEgressGuardForTests());

  const saved = () =>
    resolvedConfig({ baseUrl: 'https://api.openai.com/v1', apiKey: SAVED_KEY });

  it('never sends the saved key to a different base URL', async () => {
    const { svc } = makeService(saved());
    await svc.runTest(ACTOR, META, { baseUrl: 'https://attacker.example/v1' });
    expect(seen).toEqual([{ url: 'https://attacker.example/v1/models', auth: null }]);
  });

  it.each([
    ['a different path', 'https://api.openai.com/v2'],
    ['a different scheme', 'http://api.openai.com/v1'],
    ['a different port', 'https://api.openai.com:8443/v1'],
  ])('treats %s as a different endpoint', async (_label, baseUrl) => {
    const { svc } = makeService(saved());
    await svc.listModels({ baseUrl });
    expect(seen[0]!.auth).toBeNull();
  });

  it('reuses the saved key when the override equals the saved URL (trailing slash ignored)', async () => {
    const { svc } = makeService(saved());
    await svc.listModels({ baseUrl: 'https://api.openai.com/v1/' });
    expect(seen[0]!.auth).toBe(`Bearer ${SAVED_KEY}`);
  });

  it('reuses the saved key when only the private-network flag is overridden', async () => {
    const { svc } = makeService(saved());
    await svc.listModels({ allowPrivateNetwork: false });
    expect(seen[0]).toEqual({
      url: 'https://api.openai.com/v1/models',
      auth: `Bearer ${SAVED_KEY}`,
    });
  });

  it('sends a typed key to a new base URL', async () => {
    const { svc } = makeService(saved());
    await svc.listModels({ baseUrl: 'https://other.example/v1', apiKey: 'sk-typed' });
    expect(seen[0]!.auth).toBe('Bearer sk-typed');
  });

  it('explains a 401 from a new URL when the saved key was withheld', async () => {
    setDefaultFetchForTests(
      (() => Promise.resolve(new Response('unauthorized', { status: 401 }))) as unknown as typeof fetch,
    );
    const { svc } = makeService(saved());
    await expect(svc.listModels({ baseUrl: 'https://other.example/v1' })).rejects.toThrow(
      /only sent to the saved base URL/,
    );
  });
});

describe('AiService — model list per provider', () => {
  let call: { url: string; headers: Record<string, string> } | undefined;
  let body: unknown;

  beforeEach(() => {
    call = undefined;
    setDefaultResolveForTests(async () => ['160.79.104.10']);
    setDefaultFetchForTests(((url: string, init?: RequestInit) => {
      call = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) as unknown as typeof fetch);
  });

  afterEach(() => resetEgressGuardForTests());

  it('lists Anthropic models with native auth, the workspace header and display names', async () => {
    body = {
      data: [
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' },
        { id: 'claude-haiku-4-5' },
      ],
    };
    const { svc } = makeService(
      resolvedConfig({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1/',
        apiKey: 'k',
        anthropicWorkspaceId: 'wrkspc_01',
      }),
    );
    await expect(svc.listModels()).resolves.toEqual([
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-haiku-4-5' },
    ]);
    expect(call?.url).toBe('https://api.anthropic.com/v1/models');
    expect(call?.headers).toEqual({
      'x-api-key': 'k',
      'anthropic-version': '2023-06-01',
      'anthropic-workspace-id': 'wrkspc_01',
    });
  });

  it('uses Bearer auth and drops non-chat models for OpenAI', async () => {
    body = {
      data: [
        { id: 'gpt-5.1' },
        { id: 'text-embedding-3-large' },
        { id: 'whisper-1' },
        { id: 'gpt-realtime' },
        { id: 'o3' },
      ],
    };
    const { svc } = makeService(
      resolvedConfig({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k' }),
    );
    await expect(svc.listModels()).resolves.toEqual([{ id: 'gpt-5.1' }, { id: 'o3' }]);
    expect(call?.headers).toEqual({ Authorization: 'Bearer k' });
  });

  it('keeps every model on an OpenAI-compatible server, and ignores display_name', async () => {
    body = { data: [{ id: 'nomic-embed-text', display_name: 'x' }, { id: 'qwen3' }] };
    const { svc } = makeService(resolvedConfig({ allowPrivateNetwork: true }));
    await expect(svc.listModels()).resolves.toEqual([{ id: 'nomic-embed-text' }, { id: 'qwen3' }]);
  });

  it('sends no auth header without a key', async () => {
    body = { data: [{ id: 'm' }] };
    const { svc } = makeService(
      resolvedConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }),
    );
    await svc.listModels();
    expect(call?.headers).toEqual({ 'anthropic-version': '2023-06-01' });
  });

  it('uses the provider from the test override, not the saved one', async () => {
    body = { data: [{ id: 'claude-opus-5-5' }] };
    const { svc } = makeService(
      resolvedConfig({ baseUrl: 'https://api.anthropic.com/v1', apiKey: 'k' }),
    );
    await svc.listModels({ provider: 'anthropic' });
    expect(call?.headers['x-api-key']).toBe('k');
  });
});

describe('AiService — reply check (probe)', () => {
  type Handler = (init: RequestInit) => Promise<Response>;
  let completion: Handler;
  let calls: Array<{ url: string; headers: Record<string, string>; body: unknown }>;

  beforeEach(() => {
    calls = [];
    completion = async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
        status: 200,
      });
    setDefaultResolveForTests(async () => ['93.184.216.34']);
    setDefaultFetchForTests(((url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({
        url: String(url),
        headers,
        body: init.body ? JSON.parse(String(init.body)) : null,
      });
      return String(url).endsWith('/models')
        ? Promise.resolve(new Response(MODELS_BODY, { status: 200 }))
        : completion(init);
    }) as unknown as typeof fetch);
  });

  afterEach(() => resetEgressGuardForTests());

  const saved = () =>
    resolvedConfig({ baseUrl: 'https://llm.example/v1', apiKey: 'sk-SAVED-SECRET' });

  async function probeWith(handler?: Handler, input: Record<string, unknown> = { model: 'm1' }) {
    if (handler) completion = handler;
    const { svc, audit } = makeService(saved());
    const result = await svc.runTest(ACTOR, META, input as never);
    return { result, audit };
  }

  it('reports OK for a visible reply, with the model list', async () => {
    const { result, audit } = await probeWith();
    expect(result).toEqual({
      ok: true,
      models: [{ id: 'llama3:latest' }],
      probe: { status: 'ok' },
    });
    const sent = calls[1]!;
    expect(sent.url).toBe('https://llm.example/v1/chat/completions');
    expect((sent.body as { model: string }).model).toBe('m1');
    // The audit row has the probe status, never the reply text.
    const after = audit.log.mock.calls[0]![0].after;
    expect(after.probe).toEqual({ status: 'ok' });
    expect(JSON.stringify(after)).not.toContain('"OK"');
  });

  it('skips the probe without a model and sends no completion request', async () => {
    const { result } = await probeWith(undefined, {});
    expect(result.probe).toEqual({ status: 'skipped', reason: 'no-model' });
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      'empty',
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }),
    ],
    [
      'refused',
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '', refusal: 'no' } }] }),
          { status: 200 },
        ),
    ],
    [
      'truncated',
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }),
          { status: 200 },
        ),
    ],
    ['invalid-response', async () => new Response('<html>not json</html>', { status: 200 })],
    [
      'timeout',
      async () => {
        throw new DOMException('The operation timed out.', 'TimeoutError');
      },
    ],
    [
      'transport',
      async () => {
        throw new TypeError('fetch failed');
      },
    ],
  ] as Array<[string, Handler]>)('maps a failed reply to "%s" and keeps the models', async (code, handler) => {
    const { result } = await probeWith(handler);
    expect(result.ok).toBe(true);
    expect(result.models).toEqual([{ id: 'llama3:latest' }]);
    expect(result.probe).toEqual({ status: 'failed', reason: code });
  });

  it('maps a 404 for a missing model to an http code and keeps the models', async () => {
    const { result } = await probeWith(
      async () => new Response('{"error":"model not found"}', { status: 404 }),
    );
    expect(result.models).toEqual([{ id: 'llama3:latest' }]);
    // The strict-endpoint retry only runs on a 400.
    expect(result.probe).toEqual({ status: 'failed', reason: 'http:404 not-found' });
  });

  it('never sends the saved key to a different URL on the probe either', async () => {
    const { svc } = makeService(saved());
    await svc.runTest(ACTOR, META, { baseUrl: 'https://attacker.example/v1', model: 'm1' } as never);
    expect(calls.map((c) => c.url)).toEqual([
      'https://attacker.example/v1/models',
      'https://attacker.example/v1/chat/completions',
    ]);
    for (const c of calls) expect(c.headers.Authorization).toBeUndefined();
  });

  it('uses the native Messages API and the background budget for Anthropic', async () => {
    completion = async () =>
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }),
        { status: 200 },
      );
    const { svc } = makeService(
      resolvedConfig({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        apiKey: 'k',
        contextWindowTokens: 200_000,
      }),
    );
    const result = await svc.runTest(ACTOR, META, { model: 'claude-opus-5-5' } as never);
    expect(result.probe).toEqual({ status: 'ok' });
    const sent = calls[1]!;
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent.headers['x-api-key']).toBe('k');
    // 32 visible + 2048 reasoning headroom: Opus 5.5 always thinks.
    expect((sent.body as { max_tokens: number }).max_tokens).toBe(32 + 2_048);
  });
});
