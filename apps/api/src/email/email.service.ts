import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { MAX_ALERT_RECIPIENTS, type TestEmailSettingsInput } from '@weavestream/shared';
import { EmailNotConfiguredError, EmailSettingsService } from './email-settings.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { RequestMeta } from '../common/request-meta.js';

/**
 * Fail-closed backstop for outbound email fan-out. Alert recipient lists
 * are capped at validation (`recipientEmailsSchema`), but a row saved
 * before that cap existed — or written directly to the
 * `alert_config.recipient_emails` column — would otherwise fan out
 * uncapped through this single send chokepoint. Truncating to
 * `MAX_ALERT_RECIPIENTS` hard-bounds delivery volume regardless of how a
 * list got large (WS-031). Single-recipient callers pass through
 * untouched.
 */
export function capRecipients(to: string | string[]): string | string[] {
  if (Array.isArray(to) && to.length > MAX_ALERT_RECIPIENTS) {
    return to.slice(0, MAX_ALERT_RECIPIENTS);
  }
  return to;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly settings: EmailSettingsService,
    private readonly audit: AuditLogService,
  ) {}

  async send(input: {
    to: string | string[];
    subject: string;
    text: string;
    html?: string;
  }): Promise<void> {
    const to = capRecipients(input.to);
    if (Array.isArray(input.to) && Array.isArray(to) && to.length < input.to.length) {
      this.logger.warn(
        `Recipient list truncated from ${input.to.length} to ${to.length} (MAX_ALERT_RECIPIENTS)`,
      );
    }
    const config = await this.settings.getSendConfig();
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secureMode === 'TLS',
      requireTLS: config.secureMode === 'STARTTLS',
      ignoreTLS: config.secureMode === 'NONE',
      auth: config.username
        ? { user: config.username, pass: config.password ?? '' }
        : undefined,
    });

    await transport.sendMail({
      from: {
        name: config.fromName ?? 'Weavestream',
        address: config.fromEmail,
      },
      replyTo: config.replyTo ?? undefined,
      to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
  }

  async sendTest(
    actor: AuthedUser,
    input: TestEmailSettingsInput,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const subject = input.subject ?? 'Weavestream test email';
    let success = false;
    let error: string | null = null;

    try {
      await this.send({
        to: input.recipient,
        subject,
        text:
          'This is a test email from Weavestream. If you received it, SMTP is configured correctly.',
        html:
          '<p>This is a test email from Weavestream.</p><p>If you received it, SMTP is configured correctly.</p>',
      });
      success = true;
      return { ok: true };
    } catch (err) {
      error = messageOf(err);
      if (err instanceof EmailNotConfiguredError) throw err;
      throw new BadRequestException(`Test email failed: ${error}`);
    } finally {
      await this.audit.log({
        actorId: actor.id,
        action: AUDIT_ACTIONS.settings.emailTest,
        entityType: 'EmailSetting',
        entityId: 'singleton',
        ip: meta.ip,
        userAgent: meta.userAgent,
        before: null,
        after: {
          recipient: input.recipient,
          success,
          error,
        },
      });
    }
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Unknown SMTP error';
}
