import { BadRequestException } from '@nestjs/common';
import { AiService } from './ai.service.js';
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
    baseUrl: 'http://ollama.lan:11434/v1',
    apiKey: null,
    defaultModel: 'llama3:latest',
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
  const svc = new AiService(settings as never, audit as never);
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
    await expect(svc.listModels()).resolves.toEqual(['llama3:latest']);
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
    ).resolves.toEqual(['llama3:latest']);
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
      ).resolves.toEqual({ ok: true, models: ['llama3:latest'] });

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
