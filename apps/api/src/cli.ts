// SPDX-License-Identifier: AGPL-3.0-or-later
import './load-env.js';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import prompts from 'prompts';
import { AppModule } from './app.module.js';
import { PrismaService } from './prisma/prisma.service.js';
import { PasswordService } from './auth/password.service.js';
import { AuditLogService } from './audit/audit.service.js';
import { SearchIndexService } from './search/search-index.service.js';
import { QueuesService } from './queues/queues.service.js';
import { DomainCheckJobNames, QueueNames } from '@weavestream/shared';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  const prisma = app.get(PrismaService);
  const passwords = app.get(PasswordService);
  const audit = app.get(AuditLogService);

  const [, , cmd, ...rest] = process.argv;

  try {
    switch (cmd) {
      case 'create-admin':
        await createAdmin(prisma, passwords, audit, rest);
        break;
      case 'reset-password':
        await resetPassword(prisma, passwords, audit, rest[0]);
        break;
      case 'list-users':
        await listUsers(prisma);
        break;
      case 'rotate-sessions':
        await rotateSessions(prisma, audit);
        break;
      case 'reindex-search':
        await reindexSearch(app.get(SearchIndexService), audit);
        break;
      case 'check-domains':
        await checkDomains(app.get(QueuesService), prisma, audit, rest);
        break;
      default:
        printUsage();
        process.exit(cmd ? 1 : 0);
    }
  } finally {
    await app.close();
  }
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(`
Weavestream CLI

Commands:
  create-admin [--force]         Create the initial SUPER_ADMIN user
  reset-password <email>         Reset a user's password, revoke their sessions
  list-users                     List users (id, email, role, active, mfa)
  rotate-sessions                Revoke every active session
  reindex-search                 Rebuild the Phase 6 search index from scratch
  check-domains [--domain=<id>]  Enqueue a scheduled fan-out (default) or a single
                                 domain check via BullMQ; waits up to
                                 DOMAIN_CHECK_TIMEOUT_MS * DOMAIN_CHECK_ATTEMPTS.
`);
}

function parseFlag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

async function createAdmin(
  prisma: PrismaService,
  passwords: PasswordService,
  audit: AuditLogService,
  rest: string[],
): Promise<void> {
  const force = rest.includes('--force');
  const existing = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } });
  if (existing > 0 && !force) {
    // eslint-disable-next-line no-console
    console.error('A SUPER_ADMIN already exists. Pass --force to create another.');
    process.exit(1);
  }

  // Non-interactive path: --email / --password / --name flags.
  const flagEmail = parseFlag(rest, 'email');
  const flagPassword = parseFlag(rest, 'password');
  const flagName = parseFlag(rest, 'name') ?? 'Admin';

  let answers: { email: string; name: string; password: string; confirm: string };
  if (flagEmail && flagPassword) {
    if (!/.+@.+\..+/.test(flagEmail)) {
      console.error('invalid email');
      process.exit(1);
    }
    if (flagPassword.length < 12) {
      console.error('password too short (min 12)');
      process.exit(1);
    }
    answers = { email: flagEmail, name: flagName, password: flagPassword, confirm: flagPassword };
  } else {
    answers = (await prompts(
      [
        { type: 'text', name: 'email', message: 'Admin email', validate: (v: string) => /.+@.+\..+/.test(v) || 'invalid email' },
        { type: 'text', name: 'name', message: 'Display name', initial: 'Admin' },
        { type: 'password', name: 'password', message: 'Password (min 12 chars)', validate: (v: string) => v.length >= 12 || 'too short' },
        { type: 'password', name: 'confirm', message: 'Confirm password' },
      ],
      { onCancel: () => process.exit(1) },
    )) as typeof answers;
  }

  if (answers.password !== answers.confirm) {
    // eslint-disable-next-line no-console
    console.error('Passwords do not match.');
    process.exit(1);
  }

  const hash = await passwords.hash(answers.password);
  const user = await prisma.user.create({
    data: {
      email: answers.email.toLowerCase(),
      name: answers.name,
      passwordHash: hash,
      role: 'SUPER_ADMIN',
      isActive: true,
    },
  });

  await audit.log({
    actorId: null,
    action: 'admin.bootstrap',
    entityType: 'User',
    entityId: user.id,
    ip: 'cli',
    userAgent: 'cli',
    before: null,
    after: { email: user.email, role: user.role },
  });

  // eslint-disable-next-line no-console
  console.log(`Created admin ${user.email} (${user.id}). MFA enrollment required on first login.`);
}

async function resetPassword(
  prisma: PrismaService,
  passwords: PasswordService,
  audit: AuditLogService,
  email: string | undefined,
): Promise<void> {
  if (!email) {
    // eslint-disable-next-line no-console
    console.error('Usage: reset-password <email>');
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user) {
    // eslint-disable-next-line no-console
    console.error('No such user.');
    process.exit(1);
  }
  const answers = await prompts(
    [
      { type: 'password', name: 'password', message: 'New password (min 12 chars)', validate: (v: string) => v.length >= 12 || 'too short' },
      { type: 'password', name: 'confirm', message: 'Confirm' },
    ],
    { onCancel: () => process.exit(1) },
  );
  if (answers.password !== answers.confirm) {
    // eslint-disable-next-line no-console
    console.error('Passwords do not match.');
    process.exit(1);
  }
  const hash = await passwords.hash(answers.password);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: hash },
  });
  await prisma.session.updateMany({
    where: { userId: user.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit.log({
    actorId: null,
    action: 'admin.reset-password',
    entityType: 'User',
    entityId: user.id,
    ip: 'cli',
    userAgent: 'cli',
    before: null,
    after: null,
  });
  // eslint-disable-next-line no-console
  console.log(`Password reset for ${user.email}. All sessions revoked.`);
}

async function listUsers(prisma: PrismaService): Promise<void> {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      role: true,
      isActive: true,
      mfaEnabled: true,
      mfaEnforcementCompletedAt: true,
      lastLoginAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });
  // eslint-disable-next-line no-console
  console.table(users);
}

async function rotateSessions(prisma: PrismaService, audit: AuditLogService): Promise<void> {
  const res = await prisma.session.updateMany({
    where: { revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await audit.log({
    actorId: null,
    action: 'admin.rotate-sessions',
    entityType: 'Session',
    entityId: null,
    ip: 'cli',
    userAgent: 'cli',
    before: null,
    after: { revokedCount: res.count },
  });
  // eslint-disable-next-line no-console
  console.log(`Revoked ${res.count} sessions.`);
}

async function reindexSearch(
  searchIndex: SearchIndexService,
  audit: AuditLogService,
): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('Rebuilding search index…');
  const started = Date.now();
  const counts = await searchIndex.reindexAll();
  const ms = Date.now() - started;
  await audit.log({
    actorId: null,
    action: 'admin.reindex-search',
    entityType: 'SearchIndex',
    entityId: null,
    ip: 'cli',
    userAgent: 'cli',
    before: null,
    after: { ...counts, ms },
  });
  // eslint-disable-next-line no-console
  console.log(
    `Reindexed ${counts.assets} assets, ${counts.articles} articles, ${counts.uploads} uploads, ${counts.domains} domains in ${ms}ms.`,
  );
}

async function checkDomains(
  queues: QueuesService,
  prisma: PrismaService,
  audit: AuditLogService,
  rest: string[],
): Promise<void> {
  const domainId = parseFlag(rest, 'domain');

  if (domainId) {
    const domain = await prisma.monitoredDomain.findFirst({
      where: { id: domainId, archivedAt: null },
      select: { id: true, hostname: true },
    });
    if (!domain) {
      // eslint-disable-next-line no-console
      console.error(`No active domain with id ${domainId}.`);
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(`Enqueueing single check for ${domain.hostname}…`);
    const jobId = await queues.enqueueDomainCheck({
      kind: 'single',
      domainId: domain.id,
      actorId: null,
    });
    const outcome = await queues.waitForJob(QueueNames.domainChecks, jobId, 60_000);
    // eslint-disable-next-line no-console
    console.log(`Job ${jobId} finished: ${outcome}`);
    await audit.log({
      actorId: null,
      action: 'domain.check',
      entityType: 'MonitoredDomain',
      entityId: domain.id,
      ip: 'cli',
      userAgent: 'cli',
      before: null,
      after: { trigger: 'cli', outcome },
    });
    return;
  }

  const active = await prisma.monitoredDomain.count({ where: { archivedAt: null } });
  // eslint-disable-next-line no-console
  console.log(`Enqueueing scheduled fan-out across ${active} active domain(s)…`);
  const jobId = await queues.enqueueDomainCheck({ kind: 'scheduled' });
  const outcome = await queues.waitForJob(QueueNames.domainChecks, jobId, 60_000);
  // eslint-disable-next-line no-console
  console.log(`Scheduled sweep ${jobId} ${outcome}. Worker continues processing fanned-out jobs in background.`);
  void DomainCheckJobNames;
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('CLI error:', err);
  process.exit(1);
});
