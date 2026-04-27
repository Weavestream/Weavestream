import { BadRequestException, ConflictException } from '@nestjs/common';
import { EmailSettingsService } from './email-settings.service.js';
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
const NOW = new Date('2026-04-20T00:00:00.000Z');

function baseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'singleton',
    enabled: false,
    host: null as string | null,
    port: null as number | null,
    secureMode: 'STARTTLS',
    username: null as string | null,
    passwordCiphertext: null as string | null,
    fromName: null as string | null,
    fromEmail: null as string | null,
    replyTo: null as string | null,
    updatedAt: NOW,
    updatedBy: null as string | null,
    ...overrides,
  };
}

function makePrisma() {
  return {
    emailSetting: {
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

describe('EmailSettingsService', () => {
  it('encrypts password updates and never exposes ciphertext in DTO or audit', async () => {
    const prisma = makePrisma();
    prisma.emailSetting.findUnique.mockResolvedValue(baseRow());
    prisma.emailSetting.update.mockResolvedValue(
      baseRow({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        username: 'user',
        passwordCiphertext: 'ENC(secret)',
        fromEmail: 'noreply@example.com',
      }),
    );
    const audit = makeAudit();
    const crypto = makeCrypto();
    const svc = new EmailSettingsService(
      prisma as never,
      audit as never,
      crypto as never,
    );

    const out = await svc.update(
      ACTOR,
      {
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        username: 'user',
        password: 'secret',
        fromEmail: 'noreply@example.com',
      },
      META,
    );

    expect(crypto.encrypt).toHaveBeenCalledWith('secret');
    expect(prisma.emailSetting.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ passwordCiphertext: 'ENC(secret)' }),
      }),
    );
    expect(out).toEqual(
      expect.objectContaining({
        passwordConfigured: true,
      }),
    );
    expect(out).not.toHaveProperty('passwordCiphertext');
    const entry = audit.log.mock.calls[0]![0];
    expect(JSON.stringify(entry)).not.toContain('ENC(secret)');
    expect(JSON.stringify(entry)).not.toContain('secret');
    expect(entry.after).toEqual(
      expect.objectContaining({ passwordConfigured: true }),
    );
  });

  it('preserves password ciphertext when password is omitted', async () => {
    const prisma = makePrisma();
    prisma.emailSetting.findUnique.mockResolvedValue(
      baseRow({ passwordCiphertext: 'ENC(existing)' }),
    );
    prisma.emailSetting.update.mockResolvedValue(
      baseRow({ host: 'smtp.example.com', passwordCiphertext: 'ENC(existing)' }),
    );
    const svc = new EmailSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    await svc.update(ACTOR, { host: 'smtp.example.com' }, META);

    expect(prisma.emailSetting.update.mock.calls[0]![0].data).not.toHaveProperty(
      'passwordCiphertext',
    );
  });

  it('clears password ciphertext when requested', async () => {
    const prisma = makePrisma();
    prisma.emailSetting.findUnique.mockResolvedValue(
      baseRow({ passwordCiphertext: 'ENC(existing)' }),
    );
    prisma.emailSetting.update.mockResolvedValue(baseRow({ passwordCiphertext: null }));
    const svc = new EmailSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    const out = await svc.update(ACTOR, { clearPassword: true }, META);

    expect(prisma.emailSetting.update.mock.calls[0]![0].data).toEqual(
      expect.objectContaining({ passwordCiphertext: null }),
    );
    expect(out.passwordConfigured).toBe(false);
  });

  it('decrypts complete saved settings for sending', async () => {
    const prisma = makePrisma();
    prisma.emailSetting.findUnique.mockResolvedValue(
      baseRow({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        username: 'user',
        passwordCiphertext: 'ENC(secret)',
        fromEmail: 'noreply@example.com',
      }),
    );
    const crypto = makeCrypto();
    const svc = new EmailSettingsService(
      prisma as never,
      makeAudit() as never,
      crypto as never,
    );

    await expect(svc.getSendConfig()).resolves.toEqual(
      expect.objectContaining({ password: 'secret', host: 'smtp.example.com' }),
    );
    expect(crypto.decrypt).toHaveBeenCalledWith('ENC(secret)');
  });

  it('fails cleanly when disabled, incomplete, or undecryptable', async () => {
    const prisma = makePrisma();
    prisma.emailSetting.findUnique.mockResolvedValueOnce(baseRow({ enabled: false }));
    const svc = new EmailSettingsService(
      prisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );

    await expect(svc.getSendConfig()).rejects.toBeInstanceOf(BadRequestException);

    const incompletePrisma = makePrisma();
    incompletePrisma.emailSetting.findUnique.mockResolvedValueOnce(
      baseRow({ enabled: true }),
    );
    const incomplete = new EmailSettingsService(
      incompletePrisma as never,
      makeAudit() as never,
      makeCrypto() as never,
    );
    await expect(incomplete.getSendConfig()).rejects.toBeInstanceOf(
      BadRequestException,
    );

    const decryptPrisma = makePrisma();
    decryptPrisma.emailSetting.findUnique.mockResolvedValueOnce(
      baseRow({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        username: 'user',
        passwordCiphertext: 'bad',
        fromEmail: 'noreply@example.com',
      }),
    );
    const decrypt = new EmailSettingsService(
      decryptPrisma as never,
      makeAudit() as never,
      { ...makeCrypto(), decrypt: jest.fn(() => { throw new Error('nope'); }) } as never,
    );
    await expect(decrypt.getSendConfig()).rejects.toBeInstanceOf(ConflictException);
  });
});
