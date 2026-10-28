import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AI_DEFAULT_CONTEXT_WINDOW_TOKENS,
  AI_DEFAULT_MAX_OUTPUT_TOKENS,
} from '@weavestream/shared';
import { AiSettingsService } from './ai-settings.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import { AI_SETTINGS_API_KEY_AAD } from '../crypto/integration-secret-encryption.service.js';

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
const NOW = new Date('2026-05-11T00:00:00.000Z');

function baseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'singleton',
    enabled: false,
    baseUrl: null as string | null,
    apiKeyCiphertext: null as string | null,
    defaultModel: null as string | null,
    maxOutputTokens: null as number | null,
    contextWindowTokens: null as number | null,
    allowPrivateNetwork: false,
    provider: 'openai_compatible',
    backgroundModel: null as string | null,
    reasoningEffort: 'off',
    anthropicWorkspaceId: null as string | null,
    updatedAt: NOW,
    updatedBy: null as string | null,
    ...overrides,
  };
}

function makePrisma() {
  return {
    aiSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
    },
  };
}

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}

function makeCrypto() {
  return {
    encrypt: jest.fn((value: string) => `ENC(${value})`),
    decrypt: jest.fn((value: string) => value.slice(4, -1)),
  };
}

describe('AiSettingsService', () => {
  it('encrypts API key updates and never exposes ciphertext in DTO or audit', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(baseRow());
    prisma.aiSetting.update.mockResolvedValue(
      baseRow({
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        apiKeyCiphertext: 'ENC(sk-test)',
        defaultModel: 'llama3:latest',
      }),
    );
    const audit = makeAudit();
    const crypto = makeCrypto();
    const svc = new AiSettingsService(
      prisma as never,
      audit as never,
      crypto as never,
    );

    const out = await svc.update(
      ACTOR,
      {
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        apiKey: 'sk-test',
        defaultModel: 'llama3:latest',
      },
      META,
    );

    expect(crypto.encrypt).toHaveBeenCalledWith('sk-test', AI_SETTINGS_API_KEY_AAD);
    expect(prisma.aiSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ apiKeyCiphertext: 'ENC(sk-test)' }),
      }),
    );
    expect(out).toEqual(
      expect.objectContaining({ apiKeyConfigured: true, enabled: true }),
    );
    expect(out).not.toHaveProperty('apiKeyCiphertext');
    const entry = audit.log.mock.calls[0]![0];
    expect(JSON.stringify(entry)).not.toContain('ENC(sk-test)');
    expect(JSON.stringify(entry)).not.toContain('sk-test');
    expect(entry.after).toEqual(
      expect.objectContaining({ apiKeyConfigured: true }),
    );
  });

  it('preserves API key ciphertext when key is omitted', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      // A trailing slash is the same endpoint, so the saved key stays.
      baseRow({ baseUrl: 'http://localhost:11434/v1/', apiKeyCiphertext: 'ENC(existing)' }),
    );
    prisma.aiSetting.update.mockResolvedValue(
      baseRow({ baseUrl: 'http://localhost:11434/v1', apiKeyCiphertext: 'ENC(existing)' }),
    );
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    await svc.update(ACTOR, { baseUrl: 'http://localhost:11434/v1' }, META);

    expect(prisma.aiSetting.update.mock.calls[0]![0].data).not.toHaveProperty(
      'apiKeyCiphertext',
    );
  });

  it('rejects a new endpoint that would reuse the saved key', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({ baseUrl: 'https://api.openai.com/v1', apiKeyCiphertext: 'ENC(existing)' }),
    );
    const audit = makeAudit();
    const svc = new AiSettingsService(prisma as never, audit as never, makeCrypto() as never);

    await expect(
      svc.update(ACTOR, { provider: 'openai_compatible', baseUrl: 'https://evil.example/v1' }, META),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.aiSetting.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it.each([
    ['a new key', { apiKey: 'sk-new' }, 'ENC(sk-new)'],
    ['a key removal', { clearApiKey: true }, null],
  ])('allows a new endpoint with %s', async (_label, keyInput, ciphertext) => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({ baseUrl: 'https://api.openai.com/v1', apiKeyCiphertext: 'ENC(existing)' }),
    );
    prisma.aiSetting.update.mockResolvedValue(
      baseRow({ baseUrl: 'http://localhost:11434/v1', apiKeyCiphertext: ciphertext }),
    );
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    await svc.update(ACTOR, { baseUrl: 'http://localhost:11434/v1', ...keyInput }, META);

    expect(prisma.aiSetting.update.mock.calls[0]![0].data).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      apiKeyCiphertext: ciphertext,
    });
  });

  it('allows clearing the endpoint without touching the saved key', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({ baseUrl: 'https://api.openai.com/v1', apiKeyCiphertext: 'ENC(existing)' }),
    );
    prisma.aiSetting.update.mockResolvedValue(
      baseRow({ baseUrl: null, apiKeyCiphertext: 'ENC(existing)' }),
    );
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    await svc.update(ACTOR, { baseUrl: null }, META);

    expect(prisma.aiSetting.update.mock.calls[0]![0].data).not.toHaveProperty(
      'apiKeyCiphertext',
    );
  });

  it('clears API key ciphertext when requested', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({ apiKeyCiphertext: 'ENC(existing)' }),
    );
    prisma.aiSetting.update.mockResolvedValue(baseRow({ apiKeyCiphertext: null }));
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    const out = await svc.update(ACTOR, { clearApiKey: true }, META);

    expect(prisma.aiSetting.update.mock.calls[0]![0].data).toEqual(
      expect.objectContaining({ apiKeyCiphertext: null }),
    );
    expect(out.apiKeyConfigured).toBe(false);
  });

  it('returns resolved config for the test endpoint, decrypting the key', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        apiKeyCiphertext: 'ENC(sk-test)',
        defaultModel: 'llama3:latest',
      }),
    );
    const crypto = makeCrypto();
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      crypto as never,
    );

    await expect(svc.getConfig()).resolves.toEqual({
      provider: 'openai_compatible',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-test',
      defaultModel: 'llama3:latest',
      // No background model saved: falls back to the default model.
      backgroundModel: 'llama3:latest',
      reasoningEffort: 'off',
      anthropicWorkspaceId: null,
      maxOutputTokens: AI_DEFAULT_MAX_OUTPUT_TOKENS,
      contextWindowTokens: AI_DEFAULT_CONTEXT_WINDOW_TOKENS,
      allowPrivateNetwork: false,
    });
    expect(crypto.decrypt).toHaveBeenCalledWith('ENC(sk-test)', AI_SETTINGS_API_KEY_AAD);
  });

  it('persists the private-network opt-in and carries it into DTO, config, and audit', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({ enabled: true, baseUrl: 'http://192.168.1.50:11434/v1' }),
    );
    prisma.aiSetting.update.mockResolvedValue(
      baseRow({
        enabled: true,
        baseUrl: 'http://192.168.1.50:11434/v1',
        allowPrivateNetwork: true,
      }),
    );
    const audit = makeAudit();
    const svc = new AiSettingsService(
      prisma as never,
      audit as never,
      makeCrypto() as never,
    );

    const out = await svc.update(ACTOR, { allowPrivateNetwork: true }, META);

    expect(prisma.aiSetting.update.mock.calls[0]![0].data).toEqual(
      expect.objectContaining({ allowPrivateNetwork: true }),
    );
    expect(out.allowPrivateNetwork).toBe(true);
    // The toggle is security-relevant — the settings.ai.update audit entry
    // must record both sides of the change.
    const entry = audit.log.mock.calls[0]![0];
    expect(entry.before).toEqual(
      expect.objectContaining({ allowPrivateNetwork: false }),
    );
    expect(entry.after).toEqual(
      expect.objectContaining({ allowPrivateNetwork: true }),
    );

    // update() invalidates the cache, so getConfig re-reads the row.
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({
        enabled: true,
        baseUrl: 'http://192.168.1.50:11434/v1',
        allowPrivateNetwork: true,
      }),
    );
    const config = await svc.getConfig();
    expect(config.allowPrivateNetwork).toBe(true);
  });

  it('saves the provider fields and audits both sides, never the key', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({ enabled: true, baseUrl: 'https://api.anthropic.com/v1' }),
    );
    const saved = baseRow({
      enabled: true,
      baseUrl: 'https://api.anthropic.com/v1',
      provider: 'anthropic',
      backgroundModel: 'claude-haiku-4-5',
      reasoningEffort: 'medium',
      anthropicWorkspaceId: 'wrkspc_01',
      defaultModel: 'claude-opus-5-5',
    });
    prisma.aiSetting.update.mockResolvedValue(saved);
    const audit = makeAudit();
    const svc = new AiSettingsService(prisma as never, audit as never, makeCrypto() as never);

    const out = await svc.update(
      ACTOR,
      {
        provider: 'anthropic',
        backgroundModel: 'claude-haiku-4-5',
        reasoningEffort: 'medium',
        anthropicWorkspaceId: 'wrkspc_01',
        apiKey: 'sk-ant-secret',
      },
      META,
    );

    expect(prisma.aiSetting.update.mock.calls[0]![0].data).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        backgroundModel: 'claude-haiku-4-5',
        reasoningEffort: 'medium',
        anthropicWorkspaceId: 'wrkspc_01',
      }),
    );
    expect(out).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        backgroundModel: 'claude-haiku-4-5',
        reasoningEffort: 'medium',
        anthropicWorkspaceId: 'wrkspc_01',
      }),
    );
    const entry = audit.log.mock.calls[0]![0];
    expect(entry.before).toEqual(expect.objectContaining({ provider: 'openai_compatible' }));
    expect(entry.after).toEqual(
      expect.objectContaining({ provider: 'anthropic', anthropicWorkspaceId: 'wrkspc_01' }),
    );
    expect(JSON.stringify(entry)).not.toContain('sk-ant-secret');

    prisma.aiSetting.findUnique.mockResolvedValue(saved);
    const config = await svc.getConfig();
    expect(config.backgroundModel).toBe('claude-haiku-4-5');
    expect(config.defaultModel).toBe('claude-opus-5-5');
  });

  it('leaves the private-network opt-in untouched when omitted from an update', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({ allowPrivateNetwork: true }),
    );
    prisma.aiSetting.update.mockResolvedValue(
      baseRow({ enabled: true, allowPrivateNetwork: true }),
    );
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    await svc.update(ACTOR, { enabled: true }, META);

    expect(prisma.aiSetting.update.mock.calls[0]![0].data).not.toHaveProperty(
      'allowPrivateNetwork',
    );
  });

  it('persists token limits and resolves configured values over defaults', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(baseRow());
    prisma.aiSetting.update.mockResolvedValue(
      baseRow({
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        maxOutputTokens: 16_000,
        contextWindowTokens: 131_072,
      }),
    );
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    const out = await svc.update(
      ACTOR,
      { maxOutputTokens: 16_000, contextWindowTokens: 131_072 },
      META,
    );
    expect(prisma.aiSetting.update.mock.calls[0]![0].data).toEqual(
      expect.objectContaining({
        maxOutputTokens: 16_000,
        contextWindowTokens: 131_072,
      }),
    );
    expect(out).toEqual(
      expect.objectContaining({
        maxOutputTokens: 16_000,
        contextWindowTokens: 131_072,
      }),
    );

    const cfgPrisma = makePrisma();
    cfgPrisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        maxOutputTokens: 16_000,
        contextWindowTokens: 131_072,
      }),
    );
    const cfgSvc = new AiSettingsService(
      cfgPrisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );
    await expect(cfgSvc.getConfig()).resolves.toEqual(
      expect.objectContaining({
        maxOutputTokens: 16_000,
        contextWindowTokens: 131_072,
      }),
    );
  });

  it('clamps resolved max output tokens to half the context window', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        // Tiny window, output left blank: the default would exceed it.
        contextWindowTokens: 4096,
        maxOutputTokens: null,
      }),
    );
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    await expect(svc.getConfig()).resolves.toEqual(
      expect.objectContaining({
        contextWindowTokens: 4096,
        maxOutputTokens: 2048, // floor(4096 / 2), not the default
      }),
    );
  });

  it('allows config with no API key (local Ollama / LMStudio)', async () => {
    const prisma = makePrisma();
    prisma.aiSetting.findUnique.mockResolvedValue(
      baseRow({
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
      }),
    );
    const svc = new AiSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    await expect(svc.getConfig()).resolves.toEqual(
      expect.objectContaining({ apiKey: null }),
    );
  });

  it('fails cleanly when disabled, missing base URL, or undecryptable', async () => {
    const disabledPrisma = makePrisma();
    disabledPrisma.aiSetting.findUnique.mockResolvedValueOnce(baseRow({ enabled: false }));
    const disabled = new AiSettingsService(
      disabledPrisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );
    await expect(disabled.getConfig()).rejects.toBeInstanceOf(BadRequestException);

    const incompletePrisma = makePrisma();
    incompletePrisma.aiSetting.findUnique.mockResolvedValueOnce(baseRow({ enabled: true }));
    const incomplete = new AiSettingsService(
      incompletePrisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );
    await expect(incomplete.getConfig()).rejects.toBeInstanceOf(BadRequestException);

    const decryptPrisma = makePrisma();
    decryptPrisma.aiSetting.findUnique.mockResolvedValueOnce(
      baseRow({
        enabled: true,
        baseUrl: 'http://localhost:11434/v1',
        apiKeyCiphertext: 'bad',
      }),
    );
    const decrypt = new AiSettingsService(
      decryptPrisma as never,
      makeAudit() as never,
      { ...makeCrypto(), decrypt: jest.fn(() => { throw new Error('nope'); }) } as never,
    );
    await expect(decrypt.getConfig()).rejects.toBeInstanceOf(ConflictException);
  });
});
