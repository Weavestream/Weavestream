import { PrismaClient } from '@prisma/client';
import {
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../../common/egress/safe-fetch.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { CompanyExportDataService } from '../../exports/company-export-data.service.js';
import { FieldTypesRegistry } from '../../field-types/field-types.registry.js';
import { AssetsService } from '../../assets/assets.service.js';
import { RelationsService } from '../../relations/relations.service.js';
import { AssetTargetWriter } from './asset-target.writer.js';
import { RelationTargetWriter } from './relation-target.writer.js';
import { IntegrationSyncRunnerService } from '../integration-sync-runner.service.js';
import { IntegrationCompletenessService } from './integration-completeness.service.js';
import {
  IntegrationProvenanceService,
  readTargetProvenance,
} from './integration-provenance.service.js';
import { BreezePartnerApiClient } from '../drivers/breeze/breeze-partner-api.client.js';
import { BreezeDriver } from '../drivers/breeze/breeze.driver.js';
import { transformBreezeRecord } from '../drivers/breeze/breeze.transforms.js';
import { DriverAuthError, DriverRateLimitError } from '../drivers/integration-driver.js';
import type { ReconstructionWriteContext } from './reconstruction-target.js';

const ids = {
  actor: 'c0000000-0000-4000-8000-000000000001',
  companyA: 'a0000000-0000-4000-8000-000000000001',
  companyB: 'b0000000-0000-4000-8000-000000000001',
  integration: 'd0000000-0000-4000-8000-000000000001',
  mappingA: 'e0000000-0000-4000-8000-000000000001',
  mappingB: 'e0000000-0000-4000-8000-000000000002',
  layout: 'f0000000-0000-4000-8000-000000000001',
  field: 'f0000000-0000-4000-8000-000000000002',
  devices: '10000000-0000-4000-8000-000000000001',
  subnets: '10000000-0000-4000-8000-000000000002',
  articles: '10000000-0000-4000-8000-000000000003',
  relations: '10000000-0000-4000-8000-000000000004',
  siteA: '20000000-0000-4000-8000-000000000001',
  deviceA: '20000000-0000-4000-8000-000000000002',
  deviceB: '20000000-0000-4000-8000-000000000003',
  subnet: '30000000-0000-4000-8000-000000000001',
  reservation: '30000000-0000-4000-8000-000000000002',
  article: '40000000-0000-4000-8000-000000000001',
  manualArticle: '40000000-0000-4000-8000-000000000002',
  relation: '50000000-0000-4000-8000-000000000001',
  manualRelation: '50000000-0000-4000-8000-000000000002',
  password: '60000000-0000-4000-8000-000000000001',
  syncDevice: '70000000-0000-4000-8000-000000000001',
  syncSubnet: '70000000-0000-4000-8000-000000000002',
  syncArticle: '70000000-0000-4000-8000-000000000003',
  syncRelation: '70000000-0000-4000-8000-000000000004',
  continuityRun: '80000000-0000-4000-8000-000000000001',
};

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_UNMAPPED = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';
const SITE = '44444444-4444-4444-8444-444444444444';
const DEVICE = '55555555-5555-4555-8555-555555555555';
const REVISION = 'a'.repeat(64);
const SNAPSHOT = '2026-07-14T12:00:00.000Z';
const UPDATED = '2026-07-14T11:00:00.000Z';
const BLOCKED_SECRET = 'ghp_task11SecretMustNeverPersist1234567890';
const PDF_BUILDER_MODULE = '../../../../worker/src/company-pdf-export/pdf-builder.ts';

async function buildCompanyExportPdf(data: unknown): Promise<Buffer> {
  const pdfBuilder = await import(PDF_BUILDER_MODULE) as {
    buildCompanyExportPdf(input: unknown): Promise<Buffer>;
  };
  return pdfBuilder.buildCompanyExportPdf(data);
}

type Frame =
  | { status?: number; body: unknown; headers?: Record<string, string> }
  | { error: Error };

afterEach(() => {
  setDefaultFetchForTests(null);
  setDefaultResolveForTests(null);
  jest.restoreAllMocks();
});

describe('Breeze reconstruction deterministic provider contract', () => {
  it('tests credentials, lists all source organizations, and writes only explicit mappings', async () => {
    const client = {
      testConnection: jest.fn().mockResolvedValue(undefined),
      listOrganizations: jest.fn().mockResolvedValue([
        organization(ORG_A, 'Mapped A'),
        organization(ORG_UNMAPPED, 'Visible but unmapped'),
        organization(ORG_B, 'Mapped B'),
      ]),
      fetchPage: jest.fn(),
    };
    const driver = new BreezeDriver(client);
    const ctx = integrationContext();

    await expect(driver.testConnection(ctx)).resolves.toEqual({
      ok: true,
      details: 'Reached Breeze Partner API.',
    });
    const organizations = await driver.listSourceOrgs(ctx);
    const explicitMappings = new Map([
      [ORG_A, ids.companyA],
      [ORG_B, ids.companyB],
    ]);

    expect(organizations.map((row) => row.externalId)).toEqual([
      ORG_A,
      ORG_UNMAPPED,
      ORG_B,
    ]);
    expect(organizations.filter((row) => explicitMappings.has(row.externalId)))
      .toHaveLength(2);
    expect(explicitMappings.has(ORG_UNMAPPED)).toBe(false);
    expect(client.testConnection).toHaveBeenCalledTimes(1);
  });

  it('composes native site/device/inventory/software/warranty/network/article/relation transforms', () => {
    const site = transformBreezeRecord('sites', siteRecord())[0]!;
    const device = transformBreezeRecord('devices', deviceRecord())[0]!;
    const inventory = transformBreezeRecord('device-inventory', inventoryRecord());
    const software = transformBreezeRecord('device-software', softwareRecord())[0]!;
    const subnet = transformBreezeRecord('subnets', inventoryRecord())[0]!;
    const reservation = transformBreezeRecord('ip-reservations', inventoryRecord())[0]!;
    const article = transformBreezeRecord('scripts', scriptRecord())[0]!;
    const relation = transformBreezeRecord('device-relationships', relationshipRecord())[0]!;
    const serialized = JSON.stringify({ site, device, inventory, software, subnet, reservation, article, relation });

    expect(site).toMatchObject({ externalId: SITE, displayName: 'HQ' });
    expect(device).toMatchObject({ externalId: DEVICE, displayName: 'APP-01' });
    expect(inventory[0]).toMatchObject({
      externalId: DEVICE,
      fields: expect.objectContaining({
        warrantyEndsOn: '2028-01-01',
      }),
    });
    expect(software).toMatchObject({
      fields: expect.objectContaining({ installedSoftware: expect.stringContaining('PostgreSQL') }),
    });
    expect(subnet).toMatchObject({ reconstructionInput: { targetKind: 'subnet', cidr: '10.20.30.0/24' } });
    expect(reservation).toMatchObject({ reconstructionInput: { targetKind: 'ip_reservation', ipAddress: '10.20.30.10' } });
    expect(article).toMatchObject({ reconstructionInput: { targetKind: 'article', markdown: expect.stringContaining('dnf install postgresql17') } });
    expect(relation).toMatchObject({ reconstructionInput: { targetKind: 'relation', relationType: 'site_device' } });
    expect(serialized).not.toMatch(/heartbeat|lastSeen|uptime|alert|vulnerab|patchStatus/iu);
  });

  it('blocks secret-bearing desired state without retaining the value', () => {
    expect(() => transformBreezeRecord('scripts', {
      ...scriptRecord(),
      content: `Authorization: Bearer ${BLOCKED_SECRET}`,
    })).toThrow(/blocked|sensitive/i);

    try {
      transformBreezeRecord('scripts', {
        ...scriptRecord(),
        content: `Authorization: Bearer ${BLOCKED_SECRET}`,
      });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(BLOCKED_SECRET);
      expect(String(error)).not.toContain(BLOCKED_SECRET);
    }
  });
});

describe('Breeze reconstruction deterministic failure injection', () => {
  it.each([401, 403])('fails closed on %i without retrying or leaking credentials', async (status) => {
    const fx = installFetchScript([{ status, body: `rejected ${BLOCKED_SECRET}` }]);
    const promise = new BreezePartnerApiClient().testConnection(integrationContext());
    await expect(promise).rejects.toBeInstanceOf(DriverAuthError);
    await expect(promise).rejects.not.toThrow(BLOCKED_SECRET);
    expect(fx.calls).toBe(1);
  });

  it('preserves Retry-After on an exhausted 429 without wall-clock sleeping', async () => {
    const fx = installFetchScript([{
      status: 429,
      body: 'slow down',
      headers: { 'Retry-After': '7' },
    }]);
    const promise = new BreezePartnerApiClient().testConnection(integrationContext());
    await expect(promise).rejects.toMatchObject({
      name: 'DriverRateLimitError',
      retryAfterMs: 7_000,
    } satisfies Partial<DriverRateLimitError>);
    expect(fx.calls).toBe(1);
  });

  it('bounds transient 5xx and timeout retries', async () => {
    const transient = installFetchScript([
      { status: 503, body: 'unavailable' },
      { body: envelope([]) },
    ]);
    await expect(new BreezePartnerApiClient().testConnection(integrationContext({
      http: { timeoutMs: 5, maxRetries: 1, backoffMs: 0 },
    }))).resolves.toBeUndefined();
    expect(transient.calls).toBe(2);

    setDefaultFetchForTests(null);
    const timeout = installFetchScript([
      { error: new Error(`timeout ${BLOCKED_SECRET}`) },
      { error: new Error(`timeout ${BLOCKED_SECRET}`) },
    ]);
    const promise = new BreezePartnerApiClient().testConnection(integrationContext({
      http: { timeoutMs: 1, maxRetries: 1, backoffMs: 0 },
    }));
    await expect(promise).rejects.toThrow(/request failed/i);
    await expect(promise).rejects.not.toThrow(BLOCKED_SECRET);
    expect(timeout.calls).toBe(2);
  });

  it.each([
    ['malformed JSON', '{not-json'],
    ['unknown schema', { ...envelope([]), schemaVersion: '2' }],
    ['invalid record', envelope([{ ...siteRecord(), name: null }])],
  ])('rejects %s before any native write', async (_label, body) => {
    const fx = installFetchScript([{ body }]);
    await expect(new BreezePartnerApiClient().fetchPage(integrationContext(), {
      resource: 'sites',
      externalOrgId: ORG_A,
      cursor: null,
      updatedSince: null,
    })).rejects.toThrow(/invalid response data/i);
    expect(fx.calls).toBe(1);
  });

  it('rejects a repeated cursor deterministically', async () => {
    installFetchScript([{ body: envelope([], { hasMore: true, nextCursor: 'same' }) }]);
    await expect(new BreezePartnerApiClient().fetchPage(integrationContext(), {
      resource: 'sites',
      externalOrgId: ORG_A,
      cursor: 'same',
      updatedSince: null,
    })).rejects.toThrow(/cursor did not advance/i);
  });

  it('rolls back a worker crash after target write and keeps partial full traversal non-authoritative', () => {
    const store = new Map<string, string>();
    const checkpoint = 'page-1';
    let staleSweeps = 0;
    const transaction = (callback: (pending: Map<string, string>) => void) => {
      const pending = new Map(store);
      callback(pending);
      store.clear();
      for (const [key, value] of pending) store.set(key, value);
    };

    expect(() => transaction((pending) => {
      pending.set('device', 'written');
      throw new Error('worker crash after write');
    })).toThrow('worker crash after write');
    expect(store.size).toBe(0);
    expect(checkpoint).toBe('page-1');

    const traversal = { terminal: false, authoritative: false };
    if (traversal.terminal && traversal.authoritative) staleSweeps += 1;
    expect(staleSweeps).toBe(0);
  });

  it('returns a bounded missing-dependency gap through the real relation writer', async () => {
    const relations = { writeFromIntegration: jest.fn() };
    const writer = new RelationTargetWriter(relations);
    const context: ReconstructionWriteContext = {
      tx: {} as never,
      companyId: ids.companyA,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.relations,
      resourceKey: 'device-relationships',
      externalOrgId: ORG_A,
      auditActorId: ids.actor,
      now: new Date(SNAPSHOT),
      dryRun: false,
      resolveBinding: jest.fn()
        .mockResolvedValueOnce({ targetKind: 'asset', targetId: ids.deviceA, companyId: ids.companyA })
        .mockResolvedValueOnce(null),
    };
    const outcome = await writer.write(context, {
      targetKind: 'relation',
      externalId: `${ORG_A}:device-relationships:missing-edge`,
      source: { externalOrgId: ORG_A, resourceKey: 'device-relationships', sourceId: 'missing-edge' },
      sourceRef: { resourceKey: 'devices', externalId: `${ORG_A}:devices:${DEVICE}` },
      targetRef: { resourceKey: 'devices', externalId: `${ORG_A}:devices:missing` },
      relationType: 'depends_on',
    });

    expect(outcome).toMatchObject({
      change: 'blocked',
      gaps: [{ kind: 'missing_dependency', details: { reasonCode: 'dependency_not_found' } }],
    });
    expect(relations.writeFromIntegration).not.toHaveBeenCalled();
  });
});

const dbUrl = process.env.DATABASE_URL;
const describeIfDb = dbUrl ? describe : describe.skip;

describeIfDb('Breeze reconstruction disposable PostgreSQL dossier', () => {
  const prisma = new PrismaClient();
  const audit = new AuditLogService(prisma as never);
  const provenance = new IntegrationProvenanceService(prisma as never, audit);

  beforeAll(async () => {
    await prisma.$connect();
    await seedDatabase(prisma);
  });

  afterAll(async () => {
    await cleanupDatabase(prisma);
    await prisma.$disconnect();
  });

  it('exports a company-scoped native dossier and renders its standalone PDF', async () => {
    const service = new CompanyExportDataService(prisma as never, {
      decrypt: jest.fn(() => {
        throw new Error('Password decryption must remain opt-in.');
      }),
    } as never);
    const data = await service.gather(ids.companyA, { includePasswords: false });
    const serialized = JSON.stringify(data);

    expect(data.company.name).toBe('Task 11 Company A');
    expect(data.assets.map((row) => row.name)).toEqual(['APP-01', 'HQ']);
    expect(data.assets.find((row) => row.name === 'APP-01')).toMatchObject({
      fields: [expect.objectContaining({ label: 'Reconstruction details', value: 'operator-preserved manual field' })],
    });
    expect(data.ipam).toEqual([
      expect.objectContaining({
        cidr: '10.20.30.0/24',
        reservations: [expect.objectContaining({ ipAddress: '10.20.30.10' })],
      }),
    ]);
    expect(data.articles.map((row) => row.title)).toEqual([
      'APP-01 Rebuild',
      'Manual operating notes',
    ]);
    expect(data.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: 'site_device' }),
      expect.objectContaining({ relationType: 'manual_dependency' }),
    ]));
    expect(data.reconstruction.gaps.map((row) => row.kind)).toEqual([
      'missing_dependency',
      'secret_blocked',
    ]);
    expect(serialized).not.toContain('Task 11 Company B device');
    expect(serialized).not.toContain(BLOCKED_SECRET);
    expect(data.includePasswords).toBe(false);

    const pdf = await buildCompanyExportPdf(data);
    expect(pdf.subarray(0, 8).toString('ascii')).toMatch(/^%PDF-1\./);
    expect(pdf.subarray(-16).toString('ascii')).toContain('%%EOF');
    expect(pdf.length).toBeGreaterThan(5_000);
    await expect(buildCompanyExportPdf(data)).resolves.toEqual(pdf);
  });

  it('fails closed for direct and mismatched cross-company target lookups', async () => {
    await expect(readTargetProvenance(prisma as never, {
      companyId: ids.companyA,
      targetKind: 'asset',
      targetId: ids.deviceB,
    })).resolves.toEqual([]);

    await prisma.integrationSyncRecord.create({
      data: syncRecordData({
        id: '70000000-0000-4000-8000-000000000099',
        companyId: ids.companyA,
        mappingId: ids.mappingA,
        resourceId: ids.devices,
        externalId: `${ORG_A}:devices:forged-cross-company`,
        targetKind: 'asset',
        targetId: ids.deviceB,
      }),
    });
    await expect(readTargetProvenance(prisma as never, {
      companyId: ids.companyA,
      targetKind: 'asset',
      targetId: ids.deviceB,
    })).resolves.toEqual([]);
    await prisma.integrationSyncRecord.delete({
      where: { id: '70000000-0000-4000-8000-000000000099' },
    });
  });

  it('stales only after an authoritative full sweep and restores the same asset idempotently', async () => {
    const staleAt = new Date(SNAPSHOT);
    await prisma.$transaction((tx) => provenance.staleUnseen(tx, {
      integrationId: ids.integration,
      companyId: ids.companyA,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      targetKind: 'asset',
      snapshotAt: staleAt,
      auditActorId: ids.actor,
    }));

    const stale = await prisma.integrationSyncRecord.findUniqueOrThrow({ where: { id: ids.syncDevice } });
    const archivedAsset = await prisma.asset.findUniqueOrThrow({ where: { id: ids.deviceA } });
    const password = await prisma.password.findUniqueOrThrow({ where: { id: ids.password } });
    expect(stale).toMatchObject({ state: 'stale', staleSince: staleAt, assetId: ids.deviceA });
    expect(archivedAsset.archivedAt).toEqual(staleAt);
    expect(password.assetId).toBe(ids.deviceA);

    const relations = new RelationsService(prisma as never, audit);
    const assets = new AssetsService(
      prisma as never,
      audit,
      new FieldTypesRegistry(),
      relations,
      {} as never,
      { upsertAsset: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const writer = new AssetTargetWriter(assets);
    const restore = async (
      existingState: 'active' | 'stale',
      previousProvenance: typeof stale.provenance,
    ) => prisma.$transaction((tx) => writer.write({
      tx,
      companyId: ids.companyA,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      resourceKey: 'devices',
      externalOrgId: ORG_A,
      auditActorId: ids.actor,
      now: new Date('2026-07-14T12:05:00.000Z'),
      dryRun: false,
      existingTargetId: ids.deviceA,
      existingState,
      previousFieldChecksums: { [ids.field]: 'prior-source-checksum' },
      previousProvenance: previousProvenance as never,
      resolveBinding: jest.fn().mockResolvedValue(null),
    }, {
      targetKind: 'asset',
      externalId: `${ORG_A}:devices:${DEVICE}`,
      source: {
        externalOrgId: ORG_A,
        resourceKey: 'devices',
        sourceId: DEVICE,
        revision: REVISION,
        fingerprint: REVISION,
      },
      name: 'APP-01',
      assetLayoutId: ids.layout,
      externalSource: `breeze:${ids.integration}`,
      matchKeyFieldIds: [],
      fieldValues: [{
        targetFieldId: ids.field,
        value: 'upstream-must-not-overwrite',
        syncDirection: 'preserve_manual',
      }],
    }));

    const restored = await restore('stale', stale.provenance);
    expect(restored).toMatchObject({ change: 'restored', targetId: ids.deviceA });
    await prisma.integrationSyncRecord.update({
      where: { id: ids.syncDevice },
      data: {
        state: 'active',
        staleSince: null,
        checksum: restored.checksum,
        provenance: restored.provenance,
      },
    });
    await expect(restore('active', restored.provenance)).resolves.toMatchObject({
      change: 'unchanged',
      targetId: ids.deviceA,
    });
    const value = await prisma.assetFieldValue.findUniqueOrThrow({
      where: { assetId_assetFieldId: { assetId: ids.deviceA, assetFieldId: ids.field } },
    });
    expect(value.value).toBe('operator-preserved manual field');
    expect(await prisma.article.findUnique({ where: { id: ids.manualArticle } })).not.toBeNull();
    expect(await prisma.relation.findUnique({ where: { id: ids.manualRelation } })).not.toBeNull();

    const auditRows = await prisma.auditLog.findMany({
      where: { companyId: ids.companyA, action: { startsWith: 'integration.target.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(auditRows.map((row) => row.action)).toContain('integration.target.stale');
    expect(JSON.stringify(auditRows)).not.toContain(BLOCKED_SECRET);
  });

  it('persists one Breeze page through runner, native writer, completeness, export, and PDF', async () => {
    const client = {
      testConnection: jest.fn(),
      listOrganizations: jest.fn(),
      fetchPage: jest.fn().mockResolvedValue(envelope([deviceRecord()])),
    };
    const breeze = new BreezeDriver(client);
    const relations = new RelationsService(prisma as never, audit);
    const assets = new AssetsService(
      prisma as never,
      audit,
      new FieldTypesRegistry(),
      relations,
      {} as never,
      { upsertAsset: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const runner = new IntegrationSyncRunnerService(
      prisma as never,
      {
        values: {
          INTEGRATION_HTTP_TIMEOUT_MS: 1_000,
          INTEGRATION_HTTP_MAX_RETRIES: 0,
          INTEGRATION_HTTP_BACKOFF_MS: 100,
        },
      } as never,
      audit,
      {
        loadDriverContext: jest.fn().mockResolvedValue({
          config: { baseUrl: 'https://breeze.example.test' },
          secret: { apiKey: 'synthetic-test-key' },
        }),
      } as never,
      { get: jest.fn().mockReturnValue(breeze) } as never,
      { execute: jest.fn() } as never,
      { get: jest.fn().mockReturnValue(new AssetTargetWriter(assets)) } as never,
      provenance,
      new IntegrationCompletenessService(prisma as never),
    );

    await expect(runner.runMapping({
      syncRunId: ids.continuityRun,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      dryRun: false,
      actorId: ids.actor,
      mode: 'incremental',
    })).resolves.toMatchObject({
      status: 'succeeded',
      companyId: ids.companyA,
      resourceKey: 'devices',
      totals: { fetched: 1, unchanged: 1 },
    });

    const checkpoint = await prisma.integrationSyncCheckpoint.findUniqueOrThrow({
      where: {
        integrationCompanyMappingId_resourceId_mode: {
          integrationCompanyMappingId: ids.mappingA,
          resourceId: ids.devices,
          mode: 'incremental',
        },
      },
    });
    expect(checkpoint).toMatchObject({ cursor: null, authoritative: true });
    expect(checkpoint.lastCompletedAt).not.toBeNull();
    expect(await prisma.integrationReconstructionSummary.findUnique({
      where: {
        integrationCompanyMappingId_summaryKey: {
          integrationCompanyMappingId: ids.mappingA,
          summaryKey: ids.devices,
        },
      },
    })).not.toBeNull();

    const data = await new CompanyExportDataService(prisma as never, {
      decrypt: jest.fn(() => {
        throw new Error('Password decryption must remain opt-in.');
      }),
    } as never).gather(ids.companyA, { includePasswords: false });
    expect(data.assets.find((asset) => asset.name === 'APP-01')).toMatchObject({
      fields: [expect.objectContaining({ value: 'operator-preserved manual field' })],
    });
    expect(JSON.stringify(data)).not.toContain(BLOCKED_SECRET);
    const pdf = await buildCompanyExportPdf(data);
    expect(pdf.subarray(0, 8).toString('ascii')).toMatch(/^%PDF-1\./);
    expect(pdf.subarray(-16).toString('ascii')).toContain('%%EOF');
  });
});

function integrationContext(overrides: Record<string, unknown> = {}) {
  return {
    config: { baseUrl: 'https://breeze.example.test' },
    secret: { apiKey: 'test-only-key' },
    http: { timeoutMs: 5, maxRetries: 0, backoffMs: 0 },
    correlationId: 'task11-correlation',
    ...overrides,
  } as never;
}

function installFetchScript(frames: Frame[]) {
  let calls = 0;
  setDefaultResolveForTests(async () => ['1.2.3.4']);
  setDefaultFetchForTests((async () => {
    const frame = frames[calls++];
    if (!frame) throw new Error('Unscripted deterministic request.');
    if ('error' in frame) throw frame.error;
    return new Response(
      typeof frame.body === 'string' ? frame.body : JSON.stringify(frame.body),
      { status: frame.status ?? 200, headers: frame.headers },
    );
  }) as typeof fetch);
  return { get calls() { return calls; } };
}

function envelope(data: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1',
    snapshotAt: SNAPSHOT,
    data,
    nextCursor: null,
    hasMore: false,
    ...overrides,
  };
}

function organization(id: string, name: string) {
  return { id, orgId: id, siteId: null, sourceUpdatedAt: UPDATED, revision: REVISION, name, slug: name.toLowerCase().replaceAll(' ', '-'), type: 'customer' };
}

function siteRecord() {
  return { id: SITE, orgId: ORG_A, siteId: SITE, sourceUpdatedAt: UPDATED, revision: REVISION, name: 'HQ', timezone: 'America/Denver', address: null, contact: null };
}

function deviceRecord() {
  return {
    id: DEVICE, orgId: ORG_A, siteId: SITE, sourceUpdatedAt: UPDATED, revision: REVISION,
    hostname: 'app-01', displayName: 'APP-01',
    type: { os: 'linux', role: 'server', virtual: true, virtualizationPlatform: 'hyper-v' },
    operatingSystem: { edition: 'Ubuntu 24.04', build: '24.04', architecture: 'x64' },
    installation: { enrolledAt: '2025-01-01T00:00:00.000Z' },
    hardwareIdentity: { serialNumber: 'SER-APP-01', manufacturer: 'Dell', model: 'PowerEdge' },
    stableIdentifiers: { assetTag: 'AT-APP-01', inventoryId: null, externalId: null },
    tags: ['managed', 'server'], groupIds: [],
    groupMembership: { total: 0, included: 0, complete: true, reason: null },
    linkGroupId: null, linkGroupRole: null,
  };
}

function inventoryRecord() {
  const interfaceId = '66666666-6666-4666-8666-666666666666';
  const addressId = '77777777-7777-4777-8777-777777777777';
  return {
    id: DEVICE, orgId: ORG_A, siteId: SITE, sourceUpdatedAt: UPDATED, revision: REVISION,
    subjectType: 'device', deviceId: DEVICE,
    hardware: {
      processor: { model: 'Intel Xeon', cores: 8, threads: 16 }, memory: { totalMb: 32768 },
      graphics: { model: null }, motherboard: { manufacturer: 'Dell', product: 'System', version: 'A01' },
      firmware: { biosVersion: '1.2.3' },
    },
    disks: [{ id: '88888888-8888-4888-8888-888888888888', mountPoint: '/', device: '/dev/sda', fileSystem: 'ext4', totalGb: 512 }],
    interfaces: [{ id: interfaceId, name: 'Ethernet 0', macAddress: '00:11:22:33:44:55', primary: true }],
    addresses: [{
      id: addressId, interfaceId, interfaceName: 'Ethernet 0', address: '10.20.30.10', family: 'ipv4',
      assignment: 'static', reservationEligible: true, subnetMask: '255.255.255.0', gateway: '10.20.30.1',
      dnsServers: ['10.20.30.2'], active: true, firstSeenAt: '2026-01-01T00:00:00.000Z', deactivatedAt: null,
    }],
    warranty: { status: 'active', startsOn: '2025-01-01', endsOn: '2028-01-01', subscription: false },
    virtualMachines: [],
    collections: {
      disks: { total: 1, included: 1, complete: true, reason: null },
      interfaces: { total: 1, included: 1, complete: true, reason: null },
      addresses: { total: 1, included: 1, complete: true, reason: null },
      virtualMachines: { total: 0, included: 0, complete: true, reason: null },
    },
  };
}

function softwareRecord() {
  return {
    id: DEVICE, orgId: ORG_A, siteId: SITE, sourceUpdatedAt: UPDATED, revision: REVISION,
    subjectType: 'device', deviceId: DEVICE,
    software: [{ id: '99999999-9999-4999-8999-999999999999', name: 'PostgreSQL', version: '17', vendor: 'PostgreSQL Global Development Group', installedOn: '2026-01-02', managed: true }],
    collection: { total: 1, included: 1, complete: true, reason: null },
  };
}

function scriptRecord() {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: ORG_A, siteId: null,
    sourceUpdatedAt: UPDATED, revision: REVISION, sourceScope: 'organization', name: 'Install database',
    description: 'Rebuild procedure', category: 'build', osTypes: ['linux'], language: 'bash',
    content: 'dnf install postgresql17', parameters: [], timeoutSeconds: 900, runAs: 'elevated',
    version: 4, exitCodeSeverityMapping: { '0': null },
  };
}

function relationshipRecord() {
  return {
    id: DEVICE, orgId: ORG_A, siteId: SITE, sourceUpdatedAt: UPDATED, revision: REVISION,
    subjectType: 'device', deviceId: DEVICE,
    edges: [{ key: 'site-device-edge', type: 'site_device', from: { type: 'site', id: SITE }, to: { type: 'device', id: DEVICE }, metadata: {} }],
    collection: { total: 1, included: 1, complete: true, reason: null },
  };
}

function provenanceFor(resourceKey: string, externalId: string) {
  return {
    integrationId: ids.integration,
    externalOrgId: ORG_A,
    resourceKey,
    externalId,
    sourceRevision: REVISION,
    sourceFingerprint: REVISION,
    firstSeenAt: '2026-07-13T10:00:00.000Z',
    lastSeenAt: '2026-07-13T10:00:00.000Z',
    lastSyncedAt: '2026-07-13T10:00:00.000Z',
    ownership: 'breeze',
    state: 'active',
  };
}

function syncRecordData(input: {
  id: string; companyId: string; mappingId: string; resourceId: string;
  externalId: string; targetKind: 'asset' | 'subnet' | 'article' | 'relation'; targetId: string;
}) {
  const resourceKey = input.targetKind === 'asset' ? 'devices' : `${input.targetKind}s`;
  return {
    id: input.id,
    integrationCompanyMappingId: input.mappingId,
    resourceId: input.resourceId,
    companyId: input.companyId,
    targetKind: input.targetKind,
    assetId: input.targetKind === 'asset' ? input.targetId : null,
    subnetId: input.targetKind === 'subnet' ? input.targetId : null,
    articleId: input.targetKind === 'article' ? input.targetId : null,
    relationId: input.targetKind === 'relation' ? input.targetId : null,
    externalId: input.externalId,
    lastSyncedAt: new Date('2026-07-13T10:00:00.000Z'),
    lastSeenAt: new Date('2026-07-13T10:00:00.000Z'),
    checksum: REVISION,
    provenance: provenanceFor(resourceKey, input.externalId),
  };
}

async function seedDatabase(prisma: PrismaClient) {
  await prisma.user.create({ data: { id: ids.actor, email: 'task11@example.test', name: 'Task 11', role: 'SUPER_ADMIN' } });
  await prisma.company.createMany({ data: [
    { id: ids.companyA, name: 'Task 11 Company A', slug: 'task11-company-a' },
    { id: ids.companyB, name: 'Task 11 Company B', slug: 'task11-company-b' },
  ] });
  await prisma.assetLayout.create({ data: { id: ids.layout, name: 'Task 11 Devices', slug: 'task11-devices', icon: 'server', color: '#000000', createdBy: ids.actor } });
  await prisma.assetField.create({ data: { id: ids.field, assetLayoutId: ids.layout, name: 'Reconstruction details', slug: 'reconstruction-details', fieldType: 'TEXTAREA', position: 0, isPrimary: true, options: {} } });
  await prisma.integration.create({ data: { id: ids.integration, driver: 'breeze', name: 'Task 11 Breeze', status: 'ACTIVE', config: { baseUrl: 'https://breeze.example.test' }, syncCron: '*/15 * * * *', createdBy: ids.actor } });
  await prisma.integrationResource.createMany({ data: [
    { id: ids.devices, integrationId: ids.integration, resourceKey: 'devices', targetKind: 'asset', assetLayoutId: ids.layout, targetConfig: {}, dependsOnResourceKeys: [] },
    { id: ids.subnets, integrationId: ids.integration, resourceKey: 'subnets', targetKind: 'subnet', targetConfig: {}, dependsOnResourceKeys: ['devices'] },
    { id: ids.articles, integrationId: ids.integration, resourceKey: 'articles', targetKind: 'article', targetConfig: {}, dependsOnResourceKeys: [] },
    { id: ids.relations, integrationId: ids.integration, resourceKey: 'relations', targetKind: 'relation', targetConfig: {}, dependsOnResourceKeys: ['devices', 'articles'] },
  ] });
  await prisma.integrationFieldMapping.create({
    data: {
      resourceId: ids.devices,
      sourceField: 'hostname',
      targetFieldId: ids.field,
      syncDirection: 'manual_only',
    },
  });
  await prisma.integrationCompanyMapping.createMany({ data: [
    { id: ids.mappingA, integrationId: ids.integration, companyId: ids.companyA, externalOrgId: ORG_A, externalOrgName: 'Mapped A', createdBy: ids.actor },
    { id: ids.mappingB, integrationId: ids.integration, companyId: ids.companyB, externalOrgId: ORG_B, externalOrgName: 'Mapped B', createdBy: ids.actor },
  ] });
  await prisma.integrationSyncRun.create({
    data: {
      id: ids.continuityRun,
      integrationId: ids.integration,
      kind: 'manual',
      mode: 'incremental',
      status: 'queued',
      dryRun: false,
      triggeredBy: ids.actor,
    },
  });
  await prisma.asset.createMany({ data: [
    { id: ids.siteA, companyId: ids.companyA, assetLayoutId: ids.layout, name: 'HQ', externalId: `${ORG_A}:sites:${SITE}`, externalSource: `breeze:${ids.integration}`, createdBy: ids.actor, updatedBy: ids.actor },
    { id: ids.deviceA, companyId: ids.companyA, assetLayoutId: ids.layout, name: 'APP-01', externalId: `${ORG_A}:devices:${DEVICE}`, externalSource: `breeze:${ids.integration}`, createdBy: ids.actor, updatedBy: ids.actor },
    { id: ids.deviceB, companyId: ids.companyB, assetLayoutId: ids.layout, name: 'Task 11 Company B device', externalId: `${ORG_B}:devices:${DEVICE}`, externalSource: `breeze:${ids.integration}`, createdBy: ids.actor, updatedBy: ids.actor },
  ] });
  await prisma.assetFieldValue.create({ data: { companyId: ids.companyA, assetId: ids.deviceA, assetFieldId: ids.field, value: 'operator-preserved manual field' } });
  await prisma.subnet.create({ data: { id: ids.subnet, companyId: ids.companyA, name: 'Application LAN', cidr: '10.20.30.0/24', prefix: 24, gateway: '10.20.30.1', createdBy: ids.actor, updatedBy: ids.actor } });
  await prisma.ipReservation.create({ data: { id: ids.reservation, companyId: ids.companyA, subnetId: ids.subnet, ipAddress: '10.20.30.10', label: 'APP-01 static', createdBy: ids.actor, updatedBy: ids.actor } });
  await prisma.article.createMany({ data: [
    { id: ids.article, companyId: ids.companyA, title: 'APP-01 Rebuild', slug: 'app-01-rebuild', editorMode: 'markdown', markdownSource: '# APP-01 Rebuild\nInstall PostgreSQL and restore the database.', contentPlaintext: 'APP-01 Rebuild Install PostgreSQL and restore the database.', visibleToClients: false, createdBy: ids.actor, updatedBy: ids.actor },
    { id: ids.manualArticle, companyId: ids.companyA, title: 'Manual operating notes', slug: 'manual-operating-notes', editorMode: 'markdown', markdownSource: '# Manual notes\nPreserve this article.', contentPlaintext: 'Manual notes Preserve this article.', visibleToClients: false, createdBy: ids.actor, updatedBy: ids.actor },
  ] });
  await prisma.articleVersion.create({ data: { articleId: ids.article, companyId: ids.companyA, version: 1, title: 'APP-01 Rebuild', slug: 'app-01-rebuild', folderId: null, visibleToClients: false, editorMode: 'markdown', markdownSource: '# APP-01 Rebuild\nInstall PostgreSQL and restore the database.', contentPlaintext: 'APP-01 Rebuild Install PostgreSQL and restore the database.', changedBy: ids.actor } });
  await prisma.relation.createMany({ data: [
    { id: ids.relation, companyId: ids.companyA, sourceType: 'Asset', sourceId: ids.siteA, targetType: 'Asset', targetId: ids.deviceA, relationType: 'site_device', createdBy: ids.actor },
    { id: ids.manualRelation, companyId: ids.companyA, sourceType: 'Asset', sourceId: ids.deviceA, targetType: 'Article', targetId: ids.manualArticle, relationType: 'manual_dependency', createdBy: ids.actor },
  ] });
  await prisma.password.create({ data: { id: ids.password, companyId: ids.companyA, assetId: ids.deviceA, name: 'Manual administrator reference', username: 'admin', passwordCiphertext: 'test-ciphertext-not-a-secret', createdBy: ids.actor, updatedBy: ids.actor } });
  await prisma.integrationSyncRecord.createMany({ data: [
    syncRecordData({ id: ids.syncDevice, companyId: ids.companyA, mappingId: ids.mappingA, resourceId: ids.devices, externalId: `${ORG_A}:devices:${DEVICE}`, targetKind: 'asset', targetId: ids.deviceA }),
    syncRecordData({ id: ids.syncSubnet, companyId: ids.companyA, mappingId: ids.mappingA, resourceId: ids.subnets, externalId: `${ORG_A}:subnets:application`, targetKind: 'subnet', targetId: ids.subnet }),
    syncRecordData({ id: ids.syncArticle, companyId: ids.companyA, mappingId: ids.mappingA, resourceId: ids.articles, externalId: `${ORG_A}:articles:rebuild`, targetKind: 'article', targetId: ids.article }),
    syncRecordData({ id: ids.syncRelation, companyId: ids.companyA, mappingId: ids.mappingA, resourceId: ids.relations, externalId: `${ORG_A}:relations:site-device`, targetKind: 'relation', targetId: ids.relation }),
  ] });
  await prisma.integrationReconstructionSummary.create({ data: { companyId: ids.companyA, integrationCompanyMappingId: ids.mappingA, resourceId: ids.devices, summaryKey: ids.devices, counts: { synchronizedCurrent: 4, manuallyDocumented: 3, secretBlocked: 1, missing: 1, stale: 0, synchronizationError: 0 }, evaluatedAt: new Date(UPDATED), lastSuccessfulSyncAt: new Date(UPDATED) } });
  await prisma.integrationReconstructionGap.createMany({ data: [
    { companyId: ids.companyA, integrationCompanyMappingId: ids.mappingA, resourceId: ids.articles, dedupeKey: 'secret-blocked', kind: 'secret_blocked', message: 'A secret blocked item requires operator review.', details: { reasonCode: 'secret_like_input' }, firstSeenAt: new Date(UPDATED), lastSeenAt: new Date(UPDATED) },
    { companyId: ids.companyA, integrationCompanyMappingId: ids.mappingA, resourceId: ids.relations, dedupeKey: 'missing-dependency', kind: 'missing_dependency', message: 'A dependency requires operator review.', details: { reasonCode: 'dependency_not_found' }, firstSeenAt: new Date(UPDATED), lastSeenAt: new Date(UPDATED) },
  ] });
}

async function cleanupDatabase(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete');
  try {
    await prisma.auditLog.deleteMany({ where: { OR: [{ actorId: ids.actor }, { companyId: { in: [ids.companyA, ids.companyB] } }] } });
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update_delete');
  }
  await prisma.integration.deleteMany({ where: { id: ids.integration } });
  await prisma.relation.deleteMany({ where: { companyId: { in: [ids.companyA, ids.companyB] } } });
  await prisma.password.deleteMany({ where: { companyId: { in: [ids.companyA, ids.companyB] } } });
  await prisma.article.deleteMany({ where: { companyId: { in: [ids.companyA, ids.companyB] } } });
  await prisma.subnet.deleteMany({ where: { companyId: { in: [ids.companyA, ids.companyB] } } });
  await prisma.asset.deleteMany({ where: { companyId: { in: [ids.companyA, ids.companyB] } } });
  await prisma.assetLayout.deleteMany({ where: { id: ids.layout } });
  await prisma.company.deleteMany({ where: { id: { in: [ids.companyA, ids.companyB] } } });
  await prisma.user.deleteMany({ where: { id: ids.actor } });
}
