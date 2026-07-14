import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';

const SAFE_DATABASE_NAME = /^weavestream_task11_[a-z0-9_]+$/;
const SAFE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'postgres']);

export interface ReconstructionDatabaseTemplate {
  databaseName: string;
  readonly connectionUrl: string;
}

export interface DisposableReconstructionDatabase {
  databaseName: string;
  databaseUrl: string;
  prisma: PrismaClient;
  reset(): Promise<void>;
  drop(): Promise<void>;
}

export function reconstructionDatabaseTemplate(
  raw: string | undefined,
): ReconstructionDatabaseTemplate {
  if (!raw) {
    throw new Error(
      'WEAVESTREAM_RECONSTRUCTION_TEST_DATABASE_URL is required for the real-database suite.',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The reconstruction test database URL is not a valid dedicated URL.');
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !SAFE_HOSTS.has(url.hostname) ||
    !SAFE_DATABASE_NAME.test(databaseName)
  ) {
    throw new Error(
      'The reconstruction test database URL must target a local dedicated weavestream_task11_* database.',
    );
  }
  const result = { databaseName } as ReconstructionDatabaseTemplate;
  Object.defineProperty(result, 'connectionUrl', {
    value: url.toString(),
    enumerable: false,
    writable: false,
  });
  return result;
}

export function reconstructionRunDatabaseName(
  templateName: string,
  runToken: string,
): string {
  if (!SAFE_DATABASE_NAME.test(templateName)) {
    throw new Error('Unsafe reconstruction database template name.');
  }
  const suffix = runToken.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!suffix) throw new Error('A non-empty reconstruction database run token is required.');
  return `${templateName}_${suffix}`.slice(0, 63).replace(/_+$/g, '');
}

export async function createDisposableReconstructionDatabase(
  template: ReconstructionDatabaseTemplate,
  runToken: string,
): Promise<DisposableReconstructionDatabase> {
  const databaseName = reconstructionRunDatabaseName(template.databaseName, runToken);
  const templateUrl = new URL(template.connectionUrl);
  const adminUrl = new URL(templateUrl);
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';
  adminUrl.hash = '';
  const databaseUrl = new URL(templateUrl);
  databaseUrl.pathname = `/${databaseName}`;
  databaseUrl.search = '';
  databaseUrl.hash = '';

  const admin = new PrismaClient({ datasources: { db: { url: adminUrl.toString() } } });
  let created = false;
  try {
    await admin.$connect();
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
    try {
      execFileSync(
        'pnpm',
        ['--filter', '@weavestream/db', 'prisma:deploy'],
        {
          env: { ...process.env, DATABASE_URL: databaseUrl.toString() },
          stdio: 'pipe',
        },
      );
    } catch {
      throw new Error('Failed to migrate the disposable reconstruction test database.');
    }
  } catch (error) {
    if (created) await dropDatabase(admin, databaseName);
    await admin.$disconnect();
    throw error;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl.toString() } },
  });
  let dropped = false;
  return {
    databaseName,
    databaseUrl: databaseUrl.toString(),
    prisma,
    async reset() {
      if (!SAFE_DATABASE_NAME.test(databaseName)) {
        throw new Error('Refusing to reset an unsafe reconstruction test database.');
      }
      const tables = await prisma.$queryRaw<Array<{ tablename: string }>>`
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> '_prisma_migrations'
        ORDER BY tablename
      `;
      if (tables.length === 0) {
        throw new Error('The disposable reconstruction database has no application tables.');
      }
      const quotedTables = tables
        .map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`)
        .join(', ');
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${quotedTables} RESTART IDENTITY CASCADE`,
      );
    },
    async drop() {
      if (dropped) return;
      dropped = true;
      await prisma.$disconnect();
      try {
        await dropDatabase(admin, databaseName);
      } finally {
        await admin.$disconnect();
      }
    },
  };
}

async function dropDatabase(admin: PrismaClient, databaseName: string): Promise<void> {
  await admin.$executeRawUnsafe(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid()`,
  );
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
}
