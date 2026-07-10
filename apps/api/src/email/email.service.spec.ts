import { BadRequestException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { MAX_ALERT_RECIPIENTS } from '@weavestream/shared';
import { EmailService, capRecipients } from './email.service.js';
import { EmailNotConfiguredError } from './email-settings.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: {
    createTransport: jest.fn(),
  },
}));

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

describe('EmailService', () => {
  const createTransport = nodemailer.createTransport as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends mail through Nodemailer using saved SMTP settings', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    createTransport.mockReturnValue({ sendMail });
    const svc = new EmailService(makeSettings() as never, makeAudit() as never);

    await svc.send({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'Text',
      html: '<p>Text</p>',
    });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: 'smtp-user', pass: 'smtp-pass' },
      }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Hello',
        replyTo: 'reply@example.com',
      }),
    );
  });

  it('audits successful test emails', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    createTransport.mockReturnValue({ sendMail });
    const audit = makeAudit();
    const svc = new EmailService(makeSettings() as never, audit as never);

    await expect(
      svc.sendTest(ACTOR, { recipient: 'admin@example.com' }, META),
    ).resolves.toEqual({ ok: true });

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.email.test',
        after: expect.objectContaining({
          recipient: 'admin@example.com',
          success: true,
          error: null,
        }),
      }),
    );
  });

  it('turns SMTP test failures into validation errors and audits them', async () => {
    const sendMail = jest.fn().mockRejectedValue(new Error('Auth failed'));
    createTransport.mockReturnValue({ sendMail });
    const audit = makeAudit();
    const svc = new EmailService(makeSettings() as never, audit as never);

    await expect(
      svc.sendTest(ACTOR, { recipient: 'admin@example.com' }, META),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        after: expect.objectContaining({
          success: false,
          error: 'Auth failed',
        }),
      }),
    );
  });

  it('caps an over-cap recipient array before handing it to Nodemailer (WS-031)', async () => {
    const sendMail = jest.fn().mockResolvedValue({});
    createTransport.mockReturnValue({ sendMail });
    const svc = new EmailService(makeSettings() as never, makeAudit() as never);
    const to = Array.from({ length: 150 }, (_, i) => `u${i}@example.com`);

    await svc.send({ to, subject: 'x', text: 'y' });

    const arg = sendMail.mock.calls[0][0].to as string[];
    expect(arg).toHaveLength(MAX_ALERT_RECIPIENTS);
    expect(arg[0]).toBe('u0@example.com');
  });

  it('surfaces not-configured errors without calling Nodemailer', async () => {
    const svc = new EmailService(
      {
        getSendConfig: jest
          .fn()
          .mockRejectedValue(new EmailNotConfiguredError('Email is disabled.')),
      } as never,
      makeAudit() as never,
    );

    await expect(
      svc.sendTest(ACTOR, { recipient: 'admin@example.com' }, META),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(createTransport).not.toHaveBeenCalled();
  });
});

describe('capRecipients (WS-031 send-path backstop)', () => {
  it('truncates an over-cap array to MAX_ALERT_RECIPIENTS', () => {
    const to = Array.from({ length: 150 }, (_, i) => `u${i}@example.com`);
    const capped = capRecipients(to) as string[];
    expect(capped).toHaveLength(MAX_ALERT_RECIPIENTS);
    expect(capped[0]).toBe('u0@example.com');
  });

  it('leaves an at-cap array unchanged (same reference)', () => {
    const to = Array.from({ length: MAX_ALERT_RECIPIENTS }, (_, i) => `u${i}@x.com`);
    expect(capRecipients(to)).toBe(to);
  });

  it('passes a single-string recipient through untouched', () => {
    expect(capRecipients('one@example.com')).toBe('one@example.com');
  });
});

function makeSettings() {
  return {
    getSendConfig: jest.fn().mockResolvedValue({
      host: 'smtp.example.com',
      port: 587,
      secureMode: 'STARTTLS',
      username: 'smtp-user',
      password: 'smtp-pass',
      fromName: 'Weavestream',
      fromEmail: 'noreply@example.com',
      replyTo: 'reply@example.com',
    }),
  };
}

function makeAudit() {
  return { log: jest.fn().mockResolvedValue(undefined) };
}
