import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  AiSettingsService,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
} from './ai-settings.service.js';
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

    expect(crypto.encrypt).toHaveBeenCalledWith('sk-test');
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
      baseRow({ apiKeyCiphertext: 'ENC(existing)' }),
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
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-test',
      defaultModel: 'llama3:latest',
      maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
    });
    expect(crypto.decrypt).toHaveBeenCalledWith('ENC(sk-test)');
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
        // Tiny window, output left blank → default (8192) would exceed it.
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
        maxOutputTokens: 2048, // floor(4096 / 2), not the 8192 default
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
