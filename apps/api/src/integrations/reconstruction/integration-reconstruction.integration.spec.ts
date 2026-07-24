import { Prisma, PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  setDefaultFetchForTests,
  setDefaultResolveForTests,
} from '../../common/egress/safe-fetch.js';
import { AuditLogService } from '../../audit/audit.service.js';
import { CompanyExportDataService } from '../../exports/company-export-data.service.js';
import { FieldTypesRegistry } from '../../field-types/field-types.registry.js';
import { AssetsService } from '../../assets/assets.service.js';
import { ArticlesService } from '../../articles/articles.service.js';
import { IpamService } from '../../ipam/ipam.service.js';
import { RelationsService } from '../../relations/relations.service.js';
import { AssetTargetWriter } from './asset-target.writer.js';
import { ArticleTargetWriter } from './article-target.writer.js';
import { IpReservationTargetWriter, SubnetTargetWriter } from './ipam-target.writer.js';
import { RelationTargetWriter } from './relation-target.writer.js';
import { ReconstructionWriterRegistry } from './reconstruction-writer.registry.js';
import { IntegrationSyncRunnerService } from '../integration-sync-runner.service.js';
import { IntegrationSyncService } from '../integration-sync.service.js';
import { IntegrationCompletenessService } from './integration-completeness.service.js';
import {
  createDisposableReconstructionDatabase,
  reconstructionDatabaseTemplate,
  type DisposableReconstructionDatabase,
} from './reconstruction-test-database.js';
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
  actor: randomUUID(),
  companyA: randomUUID(),
  companyB: randomUUID(),
  integration: randomUUID(),
  mappingA: randomUUID(),
  mappingB: randomUUID(),
  layout: randomUUID(),
  field: randomUUID(),
  devices: randomUUID(),
  sites: randomUUID(),
  subnets: randomUUID(),
  reservations: randomUUID(),
  scripts: randomUUID(),
  deviceRelationships: randomUUID(),
  articles: randomUUID(),
  relations: randomUUID(),
  siteA: randomUUID(),
  deviceA: randomUUID(),
  deviceB: randomUUID(),
  subnetB: randomUUID(),
  articleB: randomUUID(),
  relationB: randomUUID(),
  subnet: randomUUID(),
  reservation: randomUUID(),
  article: randomUUID(),
  manualArticle: randomUUID(),
  relation: randomUUID(),
  manualRelation: randomUUID(),
  password: randomUUID(),
  upload: randomUUID(),
  syncDevice: randomUUID(),
  syncSubnet: randomUUID(),
  syncArticle: randomUUID(),
  syncRelation: randomUUID(),
  continuityRun: randomUUID(),
};

const ORG_A = randomUUID();
const ORG_UNMAPPED = randomUUID();
const ORG_B = randomUUID();
const SITE = randomUUID();
const DEVICE = randomUUID();
const CHAIN_SITE = randomUUID();
const CHAIN_DEVICE = randomUUID();
const CHAIN_ADDRESS = randomUUID();
// Keep the generated article slug below the intentional high-entropy secret heuristic.
const CHAIN_SCRIPT = '11111111-1111-4111-8111-111111111112';
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
    const explicitMappings = new Map<string, string>([
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

const reconstructionDatabaseUrl = process.env['WEAVESTREAM_RECONSTRUCTION_TEST_DATABASE_URL'];
const describeIfDb = reconstructionDatabaseUrl ? describe : describe.skip;

describeIfDb('Breeze reconstruction disposable PostgreSQL dossier', () => {
  let database: DisposableReconstructionDatabase;
  let prisma: PrismaClient;
  let audit: AuditLogService;
  let provenance: IntegrationProvenanceService;

  beforeAll(async () => {
    const template = reconstructionDatabaseTemplate(reconstructionDatabaseUrl);
    database = await createDisposableReconstructionDatabase(
      template,
      `${process.pid}-${randomUUID()}`,
    );
    prisma = database.prisma;
    audit = new AuditLogService(prisma as never);
    provenance = new IntegrationProvenanceService(prisma as never, audit);
    try {
      await prisma.$connect();
    } catch (error) {
      await database.drop();
      throw error;
    }
  }, 120_000);

  beforeEach(async () => {
    await database.reset();
    await seedDatabase(prisma);
  }, 30_000);

  afterAll(async () => {
    if (database) await database.drop();
  }, 30_000);

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

  it('persists distinct configured scalar custom fields on one bound device without last-writer loss', async () => {
    const resourceId = randomUUID();
    const rackFieldId = randomUUID();
    const ownerFieldId = randomUUID();
    const rackDefinitionId = '10000000-0000-4000-8000-000000000001';
    const ownerDefinitionId = '10000000-0000-4000-8000-000000000002';
    const unmappedDefinitionId = '10000000-0000-4000-8000-000000000003';
    const rackValueId = '20000000-0000-4000-8000-000000000001';
    const ownerValueId = '20000000-0000-4000-8000-000000000002';
    const unmappedValueId = '20000000-0000-4000-8000-000000000003';

    await prisma.assetField.createMany({ data: [
      {
        id: rackFieldId,
        assetLayoutId: ids.layout,
        name: 'Breeze Rack',
        slug: 'breeze-rack',
        fieldType: 'TEXT',
        position: 10,
        options: {},
      },
      {
        id: ownerFieldId,
        assetLayoutId: ids.layout,
        name: 'Breeze Owner',
        slug: 'breeze-owner',
        fieldType: 'TEXT',
        position: 11,
        options: {},
      },
    ] });
    await prisma.integrationResource.create({ data: {
      id: resourceId,
      integrationId: ids.integration,
      resourceKey: 'custom-field-values',
      targetKind: 'asset',
      assetLayoutId: ids.layout,
      targetConfig: {
        sourceEndpoint: '/custom-field-values',
        bindingResourceKey: 'devices',
      },
      dependsOnResourceKeys: ['devices'],
    } });
    await prisma.integrationFieldMapping.createMany({ data: [
      {
        resourceId,
        sourceField: rackDefinitionId,
        targetFieldId: rackFieldId,
        syncDirection: 'source_wins',
      },
      {
        resourceId,
        sourceField: ownerDefinitionId,
        targetFieldId: ownerFieldId,
        syncDirection: 'preserve_manual',
      },
    ] });

    const scalar = (
      id: string,
      definitionId: string,
      fieldKey: string,
      name: string,
      value: string,
      sourceUpdatedAt = UPDATED,
    ) => ({
      id,
      orgId: ORG_A,
      siteId: null,
      sourceUpdatedAt,
      revision: REVISION,
      deviceId: DEVICE,
      definitionId,
      target: { type: 'device', id: DEVICE },
      name,
      fieldKey,
      type: 'text',
      value,
    });
    const rack = scalar(rackValueId, rackDefinitionId, 'rack', 'Rack', 'DC1-R07');
    const owner = scalar(ownerValueId, ownerDefinitionId, 'owner', 'Owner', 'Infrastructure');
    const unmapped = scalar(
      unmappedValueId,
      unmappedDefinitionId,
      'unmapped',
      'Unmapped',
      'must-not-persist',
    );
    const { registry } = buildRealWriterRegistry(prisma, audit);
    const runner = buildRunner(
      prisma,
      audit,
      provenance,
      new BreezeDriver(new BreezePartnerApiClient()),
      registry,
    );
    const finishRun = (id: string) => prisma.integrationSyncRun.update({
      where: { id },
      data: { status: 'succeeded', finishedAt: new Date() },
    });
    const run = async (mode: 'full' | 'incremental', rows: unknown[]) => {
      installFetchScript([{ body: envelope(rows) }]);
      const syncRunId = await createQueuedRun(prisma, mode);
      const result = await runner.runMapping({
        syncRunId,
        integrationCompanyMappingId: ids.mappingA,
        resourceId,
        dryRun: false,
        actorId: ids.actor,
        mode,
      });
      await finishRun(syncRunId);
      return result;
    };
    const fieldValues = () => prisma.assetFieldValue.findMany({
      where: { assetId: ids.deviceA, assetFieldId: { in: [rackFieldId, ownerFieldId, ids.field] } },
      select: { assetFieldId: true, value: true },
      orderBy: { assetFieldId: 'asc' },
    });

    await expect(run('full', [rack, owner, unmapped])).resolves.toMatchObject({
      status: 'succeeded',
      totals: { updated: 2, unchanged: 0, blocked: 0 },
    });
    expect(Object.fromEntries((await fieldValues()).map((row) => [row.assetFieldId, row.value])))
      .toEqual({
        [rackFieldId]: 'DC1-R07',
        [ownerFieldId]: 'Infrastructure',
        [ids.field]: 'operator-preserved manual field',
      });
    const bindings = await prisma.integrationSyncRecord.findMany({
      where: { resourceId },
      select: { externalId: true, assetId: true, provenance: true },
      orderBy: { externalId: 'asc' },
    });
    expect(bindings).toHaveLength(2);
    expect(bindings.map((row) => row.externalId)).toEqual([
      `${ORG_A}:custom-field-values:${rackValueId}`,
      `${ORG_A}:custom-field-values:${ownerValueId}`,
    ].sort());
    expect(bindings.every((row) => row.assetId === ids.deviceA)).toBe(true);
    expect(bindings.map((row) => (row.provenance as { externalId: string }).externalId).sort())
      .toEqual(bindings.map((row) => row.externalId));
    expect(JSON.stringify(await fieldValues())).not.toContain('must-not-persist');

    await expect(run('full', [rack, owner, unmapped])).resolves.toMatchObject({
      status: 'succeeded',
      totals: { updated: 0, unchanged: 2, blocked: 0 },
    });
    expect(await prisma.integrationSyncRecord.count({ where: { resourceId } })).toBe(2);

    await prisma.assetFieldValue.update({
      where: { assetId_assetFieldId: { assetId: ids.deviceA, assetFieldId: ownerFieldId } },
      data: { value: 'Operator-owned' },
    });
    const ownerChanged = {
      ...owner,
      value: 'Source overwrite attempt',
      sourceUpdatedAt: '2026-07-14T11:30:00.000Z',
      revision: 'b'.repeat(64),
    };
    await expect(run('incremental', [ownerChanged])).resolves.toMatchObject({
      status: 'succeeded',
      totals: { updated: 0, unchanged: 1, blocked: 0 },
    });
    const rackChanged = {
      ...rack,
      value: 'DC1-R08',
      sourceUpdatedAt: '2026-07-14T11:45:00.000Z',
      revision: 'c'.repeat(64),
    };
    await expect(run('incremental', [rackChanged])).resolves.toMatchObject({
      status: 'succeeded',
      totals: { updated: 1, unchanged: 0, blocked: 0 },
    });
    expect(Object.fromEntries((await fieldValues()).map((row) => [row.assetFieldId, row.value])))
      .toEqual({
        [rackFieldId]: 'DC1-R08',
        [ownerFieldId]: 'Operator-owned',
        [ids.field]: 'operator-preserved manual field',
      });
    expect(await prisma.integrationSyncRecord.count({ where: { resourceId } })).toBe(2);
  });

  it('fails closed at runner, native-writer, admin-read, provenance, and export boundaries across companies', async () => {
    const actor = { id: ids.actor, role: 'SUPER_ADMIN' } as const;
    const { registry, writerByKind, services } = buildRealWriterRegistry(prisma, audit);

    await expect(readTargetProvenance(prisma as never, {
      companyId: ids.companyA,
      targetKind: 'asset',
      targetId: ids.deviceB,
    })).resolves.toEqual([]);
    await expect(services.assets.get(actor as never, ids.companyA, ids.deviceB)).rejects.toThrow();
    await expect(services.articles.getById(actor as never, ids.companyA, ids.articleB)).rejects.toThrow();
    await expect(services.ipam.getSubnetDetail(actor as never, ids.companyA, ids.subnetB)).rejects.toThrow();
    await expect(services.relations.listRelated({
      actor: actor as never,
      companyId: ids.companyA,
      entityType: 'asset',
      entityId: ids.deviceB,
    })).resolves.toMatchObject({ totalCount: 0, items: [] });

    const forgedBindingId = randomUUID();
    const forgedSourceId = randomUUID();
    await prisma.integrationSyncRecord.create({
      data: syncRecordData({
        id: forgedBindingId,
        companyId: ids.companyA,
        mappingId: ids.mappingA,
        resourceId: ids.devices,
        externalId: `${ORG_A}:devices:${forgedSourceId}`,
        targetKind: 'asset',
        targetId: ids.deviceB,
      }),
    });
    const companyBDeviceBefore = await prisma.asset.findUniqueOrThrow({ where: { id: ids.deviceB } });
    installFetchScript([{ body: envelope([{
      ...deviceRecord(),
      id: forgedSourceId,
      hostname: 'forged-cross-company',
      displayName: 'FORGED CROSS COMPANY',
    }]) }]);
    const runner = buildRunner(
      prisma,
      audit,
      provenance,
      new BreezeDriver(new BreezePartnerApiClient()),
      registry,
    );
    const forgedRunId = await createQueuedRun(prisma, 'full');
    await expect(runner.runMapping({
      syncRunId: forgedRunId,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      dryRun: false,
      actorId: ids.actor,
      mode: 'full',
    })).resolves.toMatchObject({ status: 'failed', totals: { blocked: 1 } });
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: ids.deviceB } }))
      .resolves.toEqual(companyBDeviceBefore);
    await expect(readTargetProvenance(prisma as never, {
      companyId: ids.companyA,
      targetKind: 'asset',
      targetId: ids.deviceB,
    })).resolves.toEqual([]);

    const directInputs = {
      asset: assetInput(`${ORG_A}:devices:${randomUUID()}`),
      subnet: transformBreezeRecord('subnets', inventoryRecord())[0]!.reconstructionInput!,
      article: transformBreezeRecord('scripts', scriptRecord())[0]!.reconstructionInput!,
      relation: transformBreezeRecord('device-relationships', relationshipRecord())[0]!.reconstructionInput!,
    };
    const directContext = (
      tx: Prisma.TransactionClient,
      resourceId: string,
      resourceKey: string,
      existingTargetId: string,
      input: { externalId: string },
    ) => ({
      tx,
      companyId: ids.companyA,
      integrationId: ids.integration,
      integrationCompanyMappingId: ids.mappingA,
      resourceId,
      resourceKey,
      externalOrgId: ORG_A,
      auditActorId: ids.actor,
      now: new Date(SNAPSHOT),
      dryRun: false,
      existingTargetId,
      existingState: 'active' as const,
      previousProvenance: provenanceFor(resourceKey, input.externalId) as never,
      resolveBinding: jest.fn().mockResolvedValue({
        targetKind: 'asset',
        targetId: ids.deviceA,
        companyId: ids.companyA,
      }),
    });
    const crossWriterOutcomes = await prisma.$transaction(async (tx) => Promise.all([
      writerByKind.assetWriter.write(
        directContext(tx, ids.devices, 'devices', ids.deviceB, directInputs.asset),
        directInputs.asset,
      ),
      writerByKind.subnetWriter.write(
        directContext(tx, ids.subnets, 'subnets', ids.subnetB, directInputs.subnet),
        directInputs.subnet as never,
      ),
      writerByKind.articleWriter.write(
        directContext(tx, ids.scripts, 'scripts', ids.articleB, directInputs.article),
        directInputs.article as never,
      ),
      writerByKind.relationWriter.write(
        directContext(
          tx,
          ids.deviceRelationships,
          'device-relationships',
          ids.relationB,
          directInputs.relation,
        ),
        directInputs.relation as never,
      ),
    ]));
    expect(crossWriterOutcomes).toEqual(crossWriterOutcomes.map(() => expect.objectContaining({
      change: 'blocked',
      gaps: [expect.objectContaining({
        kind: 'validation',
        details: expect.objectContaining({ reasonCode: 'target_company_mismatch' }),
      })],
    })));
    await expect(prisma.subnet.findUniqueOrThrow({ where: { id: ids.subnetB } }))
      .resolves.toMatchObject({ companyId: ids.companyB, name: 'Company B LAN' });
    await expect(prisma.article.findUniqueOrThrow({ where: { id: ids.articleB } }))
      .resolves.toMatchObject({ companyId: ids.companyB, title: 'Company B article' });
    await expect(prisma.relation.findUniqueOrThrow({ where: { id: ids.relationB } }))
      .resolves.toMatchObject({ companyId: ids.companyB, relationType: 'company_b_dependency' });

    const exportA = await new CompanyExportDataService(prisma as never, {
      decrypt: jest.fn(),
    } as never).gather(ids.companyA, { includePasswords: false });
    expect(JSON.stringify(exportA)).not.toMatch(/Company B device|Company B article|Company B LAN/);
    await prisma.integrationSyncRun.update({
      where: { id: forgedRunId },
      data: { status: 'failed', finishedAt: new Date() },
    });
    await prisma.integrationSyncRecord.delete({ where: { id: forgedBindingId } });
  });

  it('stales only after an authoritative full sweep and restores the same asset idempotently', async () => {
    const staleAt = new Date(SNAPSHOT);
    const manualContentBefore = await Promise.all([
      prisma.company.findUniqueOrThrow({
        where: { id: ids.companyA },
        select: { notes: true, quickNotes: true },
      }),
      prisma.upload.findUniqueOrThrow({ where: { id: ids.upload } }),
    ]);
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
    await expect(Promise.all([
      prisma.company.findUniqueOrThrow({
        where: { id: ids.companyA },
        select: { notes: true, quickNotes: true },
      }),
      prisma.upload.findUniqueOrThrow({ where: { id: ids.upload } }),
    ])).resolves.toEqual(manualContentBefore);

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
    await expect(Promise.all([
      prisma.company.findUniqueOrThrow({
        where: { id: ids.companyA },
        select: { notes: true, quickNotes: true },
      }),
      prisma.upload.findUniqueOrThrow({ where: { id: ids.upload } }),
    ])).resolves.toEqual(manualContentBefore);

    const auditRows = await prisma.auditLog.findMany({
      where: { companyId: ids.companyA, action: { startsWith: 'integration.target.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(auditRows.map((row) => row.action)).toContain('integration.target.stale');
    expect(JSON.stringify(auditRows)).not.toContain(BLOCKED_SECRET);
  });

  it('skips a binding refreshed by a concurrent commit between the sweep scan and the guarded stale transition', async () => {
    const staleAt = new Date(SNAPSHOT);
    const refreshedAt = new Date('2026-07-14T12:30:00.000Z');
    let refreshedMidSweep = false;
    const result = await prisma.$transaction(async (tx) => {
      // Forwarding client whose candidate scan triggers the CR-011
      // interleaving: the moment the sweep has selected its stale
      // candidates, a concurrent page commits a fresh observation of
      // the same binding on a separate connection (auto-commit,
      // outside the sweep's transaction).
      const sweepTx = {
        integrationSyncRecord: {
          findMany: async (args: Parameters<typeof tx.integrationSyncRecord.findMany>[0]) => {
            const page = await tx.integrationSyncRecord.findMany(args);
            if (!refreshedMidSweep) {
              refreshedMidSweep = true;
              await prisma.integrationSyncRecord.update({
                where: { id: ids.syncDevice },
                data: {
                  lastSeenAt: refreshedAt,
                  provenance: {
                    ...provenanceFor('devices', `${ORG_A}:devices:${DEVICE}`),
                    lastSeenAt: refreshedAt.toISOString(),
                  },
                },
              });
            }
            return page;
          },
        },
        $queryRaw: tx.$queryRaw.bind(tx),
        $executeRaw: tx.$executeRaw.bind(tx),
        asset: tx.asset,
        article: tx.article,
        subnet: tx.subnet,
        searchIndex: tx.searchIndex,
        auditLog: tx.auditLog,
      } as unknown as Prisma.TransactionClient;
      return provenance.staleUnseen(sweepTx, {
        integrationId: ids.integration,
        companyId: ids.companyA,
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.devices,
        targetKind: 'asset',
        snapshotAt: staleAt,
        auditActorId: ids.actor,
      });
    });

    // The guarded transition re-evaluates its predicate against the
    // committed refresh, so the binding drops out of the sweep: no
    // stale flip, no target archive, no audit entry.
    expect(refreshedMidSweep).toBe(true);
    expect(result).toEqual({ stale: 0, archived: 0 });
    await expect(prisma.integrationSyncRecord.findUniqueOrThrow({ where: { id: ids.syncDevice } }))
      .resolves.toMatchObject({ state: 'active', staleSince: null, lastSeenAt: refreshedAt });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: ids.deviceA } });
    expect(asset.archivedAt).toBeNull();
    await expect(prisma.auditLog.findMany({
      where: { companyId: ids.companyA, action: 'integration.target.stale' },
    })).resolves.toEqual([]);
  });

  it('serializes a page holding target and binding locks against a concurrent sweep without deadlock or clobber', async () => {
    const staleAt = new Date(SNAPSHOT);
    const refreshedAt = new Date('2026-07-14T12:30:00.000Z');
    let releasePage!: () => void;
    const pageHold = new Promise<void>((resolve) => { releasePage = resolve; });
    let signalPageWritesDone!: () => void;
    const pageWritesDone = new Promise<void>((resolve) => { signalPageWritesDone = resolve; });

    // A page-shaped transaction in the runner's lock order: scope
    // watermark first, then the native target, then the binding — held
    // open while a full-reconciliation sweep starts. Without the
    // common top lock this pair is the reviewer's P1: opposite
    // target/binding lock ordering deadlocks when the page updated the
    // target, and a page blocked only on the binding resumes after the
    // sweep's commit and reactivates a binding whose target the sweep
    // archived. With the watermark first, the sweep queues before
    // scanning and then its write-predicate guard sees the committed
    // refresh.
    const page = prisma.$transaction(async (tx) => {
      await provenance.lockScope(tx, {
        companyId: ids.companyA,
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.devices,
        observedAt: refreshedAt,
      });
      await tx.asset.update({
        where: { id: ids.deviceA },
        data: { updatedBy: ids.actor },
      });
      await tx.integrationSyncRecord.update({
        where: { id: ids.syncDevice },
        data: {
          lastSeenAt: refreshedAt,
          provenance: {
            ...provenanceFor('devices', `${ORG_A}:devices:${DEVICE}`),
            lastSeenAt: refreshedAt.toISOString(),
          },
        },
      });
      signalPageWritesDone();
      await pageHold;
    }, { timeout: 30_000 });

    await pageWritesDone;
    const sweep = prisma.$transaction((tx) => provenance.staleUnseen(tx, {
      integrationId: ids.integration,
      companyId: ids.companyA,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      targetKind: 'asset',
      snapshotAt: staleAt,
      auditActorId: ids.actor,
    }), { timeout: 30_000 });
    // Give the sweep time to queue on the watermark the page holds,
    // then let the page commit; any interleaving must end the same way.
    await new Promise((resolve) => setTimeout(resolve, 250));
    releasePage();
    await page;

    await expect(sweep).resolves.toEqual({ stale: 0, archived: 0 });
    await expect(prisma.integrationSyncRecord.findUniqueOrThrow({ where: { id: ids.syncDevice } }))
      .resolves.toMatchObject({ state: 'active', staleSince: null, lastSeenAt: refreshedAt });
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: ids.deviceA } });
    expect(asset.archivedAt).toBeNull();
  });

  it('composes the real Breeze request seam, registry, every native writer, completeness, export, and PDF idempotently', async () => {
    const breeze = new BreezeDriver(new BreezePartnerApiClient());
    installFetchScript([{ body: envelope([
      organization(ORG_A, 'Mapped A'),
      organization(ORG_UNMAPPED, 'Visible but unmapped'),
      organization(ORG_B, 'Mapped B'),
    ]) }]);
    await expect(breeze.listSourceOrgs(integrationContext())).resolves.toEqual([
      expect.objectContaining({ externalId: ORG_A }),
      expect.objectContaining({ externalId: ORG_UNMAPPED }),
      expect.objectContaining({ externalId: ORG_B }),
    ]);
    await expect(prisma.integrationCompanyMapping.findFirst({
      where: { integrationId: ids.integration, externalOrgId: ORG_UNMAPPED },
    })).resolves.toBeNull();

    const { registry, writers } = buildRealWriterRegistry(prisma, audit);
    const writeSpies = writers.map((writer) => jest.spyOn(writer, 'write'));
    let queryCount = 0;
    prisma.$use(async (params, next) => {
      queryCount += 1;
      return next(params);
    });
    const runner = buildRunner(prisma, audit, provenance, breeze, registry);
    const firstRecords = chainRecords(UPDATED);
    const secondRecords = chainRecords('2026-07-14T11:30:00.000Z');
    const resources = [
      [ids.sites, firstRecords.site, secondRecords.site],
      [ids.devices, firstRecords.device, secondRecords.device],
      [ids.subnets, firstRecords.inventory, secondRecords.inventory],
      [ids.reservations, firstRecords.inventory, secondRecords.inventory],
      [ids.scripts, firstRecords.script, secondRecords.script],
      [ids.deviceRelationships, firstRecords.relationship, secondRecords.relationship],
    ] as const;

    const firstOutcomes = [];
    for (const [resourceId, first] of resources) {
      installFetchScript([{ body: envelope([first]) }]);
      firstOutcomes.push(await runner.runMapping({
        syncRunId: await createQueuedRun(prisma, 'incremental'),
        integrationCompanyMappingId: ids.mappingA,
        resourceId,
        dryRun: false,
        actorId: ids.actor,
        mode: 'incremental',
      }));
    }
    expect(firstOutcomes).toEqual(resources.map(() => expect.objectContaining({
      status: 'succeeded',
      totals: expect.objectContaining({ fetched: 1, created: 1 }),
    })));

    const firstBindings = await prisma.integrationSyncRecord.findMany({
      where: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: { in: resources.map(([resourceId]) => resourceId) },
        id: { notIn: [ids.syncDevice, ids.syncSubnet, ids.syncArticle, ids.syncRelation] },
      },
      orderBy: { externalId: 'asc' },
    });
    expect(firstBindings).toHaveLength(6);
    const stableTargets = firstBindings.map((binding) => ({
      externalId: binding.externalId,
      assetId: binding.assetId,
      subnetId: binding.subnetId,
      ipReservationId: binding.ipReservationId,
      articleId: binding.articleId,
      relationId: binding.relationId,
    }));

    const secondOutcomes = [];
    for (const [resourceId, , second] of resources) {
      installFetchScript([{ body: envelope([second]) }]);
      secondOutcomes.push(await runner.runMapping({
        syncRunId: await createQueuedRun(prisma, 'incremental'),
        integrationCompanyMappingId: ids.mappingA,
        resourceId,
        dryRun: false,
        actorId: ids.actor,
        mode: 'incremental',
      }));
    }
    expect(secondOutcomes).toEqual(resources.map(() => expect.objectContaining({
      status: 'succeeded',
      totals: expect.objectContaining({ fetched: 1, unchanged: 1 }),
    })));
    expect(writeSpies.map((spy) => spy.mock.calls.length)).toEqual([4, 2, 2, 2, 2]);
    expect(writeSpies.every((spy) => spy.mock.calls.every((call) => call.length === 2))).toBe(true);
    expect(queryCount).toBeGreaterThan(0);
    expect(queryCount).toBeLessThanOrEqual(500);
    await expect(prisma.integrationSyncCheckpoint.count({
      where: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: { in: resources.map(([resourceId]) => resourceId) },
        mode: 'incremental',
        lastCompletedAt: { not: null },
      },
    })).resolves.toBe(6);
    await expect(prisma.integrationSyncRecord.findMany({
      where: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: { in: resources.map(([resourceId]) => resourceId) },
        id: { notIn: [ids.syncDevice, ids.syncSubnet, ids.syncArticle, ids.syncRelation] },
      },
      orderBy: { externalId: 'asc' },
      select: {
        externalId: true,
        assetId: true,
        subnetId: true,
        ipReservationId: true,
        articleId: true,
        relationId: true,
      },
    })).resolves.toEqual(stableTargets);
    await expect(prisma.integrationSyncRecord.count({
      where: { companyId: ids.companyA, externalId: { contains: ORG_UNMAPPED } },
    })).resolves.toBe(0);

    const data = await new CompanyExportDataService(prisma as never, {
      decrypt: jest.fn(() => {
        throw new Error('Password decryption must remain opt-in.');
      }),
    } as never).gather(ids.companyA, { includePasswords: false });
    expect(data.assets.map((asset) => asset.name)).toEqual(expect.arrayContaining([
      'Task11 chain site',
      'Task11 chain device',
    ]));
    expect(data.ipam).toEqual(expect.arrayContaining([
      expect.objectContaining({ cidr: '10.77.88.0/24' }),
    ]));
    expect(data.articles.map((article) => article.title)).toContain('Task11 chain rebuild');
    expect(data.relations).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationType: 'site_device' }),
    ]));
    expect(data.reconstruction.summaries.length).toBeGreaterThan(0);
    expect(JSON.stringify(data)).not.toContain(BLOCKED_SECRET);
    const pdf = await buildCompanyExportPdf(data);
    expect(pdf.subarray(0, 8).toString('ascii')).toMatch(/^%PDF-1\./);
    expect(pdf.subarray(-16).toString('ascii')).toContain('%%EOF');
  }, 30_000);

  it('measures actual runner queries and writer calls and deduplicates a scheduled delivery durably', async () => {
    let queryCount = 0;
    prisma.$use(async (params, next) => {
      queryCount += 1;
      return next(params);
    });
    const writer = await buildAssetWriter(prisma, audit);
    const writeSpy = jest.spyOn(writer, 'write');
    const sourceId = randomUUID();
    installFetchScript([{ body: envelope([{
      ...deviceRecord(),
      id: sourceId,
      hostname: 'instrumented-01',
      displayName: 'Instrumented runner asset',
      sourceUpdatedAt: '2026-07-14T11:45:00.000Z',
    }]) }]);
    const runId = await createQueuedRun(prisma, 'incremental');
    queryCount = 0;
    const runner = buildRunner(
      prisma,
      audit,
      provenance,
      new BreezeDriver(new BreezePartnerApiClient()),
      writer,
    );

    await expect(runner.runMapping({
      syncRunId: runId,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      dryRun: false,
      actorId: ids.actor,
      mode: 'incremental',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { fetched: 1, created: 1 } });
    const runnerQueryCount = queryCount;
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(runnerQueryCount).toBeGreaterThan(0);
    expect(runnerQueryCount).toBeLessThan(100);

    const deliveryKey = `task11:${randomUUID()}`;
    const sync = new IntegrationSyncService(
      prisma as never,
      audit,
      {} as never,
      {} as never,
    );
    const first = await sync.createScheduledRun(
      ids.integration,
      'incremental',
      new Date(SNAPSHOT),
      deliveryKey,
    );
    const second = await sync.createScheduledRun(
      ids.integration,
      'incremental',
      new Date(SNAPSHOT),
      deliveryKey,
    );
    expect(second.id).toBe(first.id);
    await expect(prisma.integrationSyncRun.count({ where: { deliveryKey } })).resolves.toBe(1);
  });

  it.each([
    ['401 authentication rejection', { status: 401, body: 'rejected' }],
    ['403 authorization rejection', { status: 403, body: 'rejected' }],
    ['429 rate limit', { status: 429, body: 'slow down', headers: { 'Retry-After': '1' } }],
    ['503 upstream failure', { status: 503, body: 'unavailable' }],
    ['transport timeout', { error: new Error('deterministic timeout') }],
    ['malformed response', { body: '{not-json' }],
    ['unknown schema', { body: { ...envelope([]), schemaVersion: '2' } }],
    ['invalid record', { body: envelope([{ ...deviceRecord(), hostname: null }]) }],
  ] as const)('preserves persisted last-known-good state after %s', async (_label, frame) => {
    const before = await persistedDeviceState(prisma);
    installFetchScript([frame]);
    const runId = await createQueuedRun(prisma, 'incremental');
    const runner = buildRunner(
      prisma,
      audit,
      provenance,
      new BreezeDriver(new BreezePartnerApiClient()),
      await buildAssetWriter(prisma, audit),
    );

    await expect(runner.runMapping({
      syncRunId: runId,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      dryRun: false,
      actorId: ids.actor,
      mode: 'incremental',
    })).resolves.toMatchObject({ status: 'failed', totals: { errors: 1 } });

    expect(await persistedDeviceState(prisma)).toEqual(before);
  });

  it('persists a committed page cursor, suppresses stale, and resumes after a repeated cursor failure', async () => {
    const orphanAssetId = randomUUID();
    const orphanBindingId = randomUUID();
    const orphanExternalId = `${ORG_A}:devices:${randomUUID()}`;
    await prisma.asset.create({
      data: {
        id: orphanAssetId,
        companyId: ids.companyA,
        assetLayoutId: ids.layout,
        name: 'Last-known-good orphan candidate',
        createdBy: ids.actor,
        updatedBy: ids.actor,
      },
    });
    await prisma.integrationSyncRecord.create({
      data: syncRecordData({
        id: orphanBindingId,
        companyId: ids.companyA,
        mappingId: ids.mappingA,
        resourceId: ids.devices,
        externalId: orphanExternalId,
        targetKind: 'asset',
        targetId: orphanAssetId,
      }),
    });
    installFetchScript([
      { body: envelope([deviceRecord()], { hasMore: true, nextCursor: 'resume-page-2' }) },
      { body: envelope([], { hasMore: true, nextCursor: 'resume-page-2' }) },
    ]);
    const runner = buildRunner(
      prisma,
      audit,
      provenance,
      new BreezeDriver(new BreezePartnerApiClient()),
      await buildAssetWriter(prisma, audit),
    );
    const failedRunId = await createQueuedRun(prisma, 'full');

    await expect(runner.runMapping({
      syncRunId: failedRunId,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      dryRun: false,
      actorId: ids.actor,
      mode: 'full',
    })).resolves.toMatchObject({ status: 'failed', totals: { fetched: 1, unchanged: 1, stale: 0 } });

    const partial = await prisma.integrationSyncCheckpoint.findUniqueOrThrow({
      where: { integrationCompanyMappingId_resourceId_mode: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.devices,
        mode: 'full',
      } },
    });
    expect(partial).toMatchObject({ cursor: 'resume-page-2', authoritative: true, lastCompletedAt: null });
    expect(await prisma.integrationSyncRecord.findUniqueOrThrow({ where: { id: orphanBindingId } }))
      .toMatchObject({ state: 'active', staleSince: null });
    expect(await prisma.asset.findUniqueOrThrow({ where: { id: orphanAssetId } }))
      .toMatchObject({ archivedAt: null });

    await prisma.integrationSyncRun.update({
      where: { id: failedRunId },
      data: { status: 'failed', finishedAt: new Date() },
    });
    installFetchScript([{ body: envelope([]) }]);
    const resumedRunId = await createQueuedRun(prisma, 'full');
    await expect(runner.runMapping({
      syncRunId: resumedRunId,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      dryRun: false,
      actorId: ids.actor,
      mode: 'full',
    })).resolves.toMatchObject({ status: 'succeeded', totals: { fetched: 0, stale: 1 } });
    const completed = await prisma.integrationSyncCheckpoint.findUniqueOrThrow({
      where: { integrationCompanyMappingId_resourceId_mode: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.devices,
        mode: 'full',
      } },
    });
    expect(completed).toMatchObject({ cursor: null, authoritative: true });
    expect(completed.lastCompletedAt).not.toBeNull();
  });

  it('rolls back a native mutation and checkpoint when a worker crashes inside the page transaction', async () => {
    const before = await persistedDeviceState(prisma);
    installFetchScript([{ body: envelope([{
      ...deviceRecord(),
      sourceUpdatedAt: '2026-07-14T11:55:00.000Z',
    }]) }]);
    const crashingWriter = {
      targetKind: 'asset',
      async write(context: ReconstructionWriteContext) {
        await context.tx.asset.update({
          where: { id: ids.deviceA },
          data: { name: 'MUTATION THAT MUST ROLL BACK' },
        });
        throw new Error('deterministic worker crash after native mutation');
      },
    };
    const runId = await createQueuedRun(prisma, 'incremental');
    const runner = buildRunner(
      prisma,
      audit,
      provenance,
      new BreezeDriver(new BreezePartnerApiClient()),
      crashingWriter,
    );

    await expect(runner.runMapping({
      syncRunId: runId,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      dryRun: false,
      actorId: ids.actor,
      mode: 'incremental',
    })).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('deterministic worker crash'),
    });
    expect(await persistedDeviceState(prisma)).toEqual(before);
  });

  it('keeps the 10,000-device production terminal transaction inside cadence bounds', async () => {
    const resourceId = ids.devices;
    // seedDatabase already provides one bound device in this exact production
    // resource, so 9,999 additional rows exercise the 10,000 binding cap.
    const targets = Array.from({ length: 9_999 }, (_, index) => ({
      assetId: randomUUID(),
      bindingId: randomUUID(),
      externalId: `${ORG_A}:task11-scale:${index}`,
    }));
    await prisma.asset.createMany({
      data: targets.map((target, index) => ({
        id: target.assetId,
        companyId: ids.companyA,
        assetLayoutId: ids.layout,
        name: `Task11 terminal target ${index}`,
        createdBy: ids.actor,
        updatedBy: ids.actor,
      })),
    });
    await prisma.integrationSyncRecord.createMany({
      data: targets.map((target) => ({
        ...syncRecordData({
          id: target.bindingId,
          companyId: ids.companyA,
          mappingId: ids.mappingA,
          resourceId,
          externalId: target.externalId,
          targetKind: 'asset',
          targetId: target.assetId,
        }),
        provenance: provenanceFor('devices', target.externalId),
      })),
    });
    const batchSizes: number[] = [];
    const auditBatchSizes: number[] = [];
    let queryCount = 0;
    prisma.$use(async (params, next) => {
      queryCount += 1;
      const idsArg = (params.args as {
        where?: { id?: { in?: unknown[] } };
      } | undefined)?.where?.id?.in;
      if (params.model === 'Asset' && params.action === 'updateMany' && Array.isArray(idsArg)) {
        batchSizes.push(idsArg.length);
      }
      const auditRows = (params.args as { data?: unknown[] } | undefined)?.data;
      if (params.model === 'AuditLog' && params.action === 'createMany' && Array.isArray(auditRows)) {
        auditBatchSizes.push(auditRows.length);
      }
      return next(params);
    });
    installFetchScript([{ body: envelope([]) }]);
    const runner = buildRunner(
      prisma,
      audit,
      provenance,
      new BreezeDriver(new BreezePartnerApiClient()),
      await buildAssetWriter(prisma, audit),
    );
    const runId = await createQueuedRun(prisma, 'full');
    queryCount = 0;
    const heapBefore = process.memoryUsage().heapUsed;
    let peakHeap = heapBefore;
    const sampler = setInterval(() => {
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }, 5);
    const startedAt = performance.now();
    let outcome: Awaited<ReturnType<IntegrationSyncRunnerService['runMapping']>> | undefined;
    try {
      outcome = await runner.runMapping({
        syncRunId: runId,
        integrationCompanyMappingId: ids.mappingA,
        resourceId,
        dryRun: false,
        actorId: ids.actor,
        mode: 'full',
      });
    } finally {
      clearInterval(sampler);
    }
    const durationMs = performance.now() - startedAt;
    const peakHeapGrowth = Math.max(0, peakHeap - heapBefore);

    expect(outcome?.error).toBeNull();
    expect(outcome).toMatchObject({
      status: 'succeeded', totals: { fetched: 0, stale: 10_000, archived: 10_000 },
    });
    expect(batchSizes).toHaveLength(20);
    expect(batchSizes.every((size) => size === 500)).toBe(true);
    expect(auditBatchSizes).toHaveLength(20);
    expect(auditBatchSizes.every((size) => size === 500)).toBe(true);
    expect(queryCount).toBeLessThan(300);
    expect(peakHeapGrowth).toBeLessThan(384 * 1024 * 1024);
    expect(durationMs).toBeLessThan(60_000);
    expect(durationMs).toBeLessThan(15 * 60_000);
    await expect(prisma.asset.count({
      where: { id: { in: targets.map((target) => target.assetId) }, archivedAt: { not: null } },
    })).resolves.toBe(9_999);
    await expect(prisma.asset.findUniqueOrThrow({ where: { id: ids.deviceA } }))
      .resolves.toMatchObject({ archivedAt: expect.any(Date) });
    await expect(prisma.integrationSyncRecord.count({
      where: { resourceId, state: 'stale', provenance: { path: ['state'], equals: 'stale' } },
    })).resolves.toBe(10_000);
    await expect(prisma.auditLog.count({
      where: { companyId: ids.companyA, action: 'integration.target.stale' },
    })).resolves.toBeGreaterThanOrEqual(10_000);
    await expect(prisma.integrationSyncCheckpoint.findUniqueOrThrow({
      where: { integrationCompanyMappingId_resourceId_mode: {
        integrationCompanyMappingId: ids.mappingA, resourceId, mode: 'full',
      } },
    })).resolves.toMatchObject({ cursor: null, authoritative: true });
  }, 120_000);

  it('never lets an older evaluation that finishes later move the scorecard or gaps backward', async () => {
    const completeness = new IntegrationCompletenessService(prisma as never);
    const older = new Date('2026-07-20T10:00:00.000Z');
    const newer = new Date('2026-07-20T11:00:00.000Z');
    const newest = new Date('2026-07-20T12:00:00.000Z');
    const scopeAt = (evaluatedAt: Date) => ({
      companyId: ids.companyA,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.scripts,
      evaluatedAt,
    });
    const summaryWhere = { integrationCompanyMappingId_summaryKey: {
      integrationCompanyMappingId: ids.mappingA,
      summaryKey: ids.scripts,
    } };
    const completenessGaps = () => prisma.integrationReconstructionGap.findMany({
      where: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.scripts,
        dedupeKey: { startsWith: 'completeness:' },
      },
      orderBy: { dedupeKey: 'asc' },
      select: { id: true, lastSeenAt: true, resolvedAt: true, firstSeenAt: true },
    });
    const provenanceScopeAt = (observedAt: Date) => ({
      companyId: ids.companyA,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.scripts,
      observedAt,
    });
    const observation = {
      externalId: `${ORG_A}:scripts:script-9`,
      syncRecordId: null,
      kind: 'validation' as const,
      message: 'Input requires operator review.',
      details: { reasonCode: 'schema_mismatch' },
    };
    const validationGap = () => prisma.integrationReconstructionGap.findFirstOrThrow({
      where: { integrationCompanyMappingId: ids.mappingA, resourceId: ids.scripts, kind: 'validation' },
    });

    // A provenance gap observed before any authoritative evaluation
    // exists inserts freely — seeding the scope's watermark tombstone
    // as its serialization point in the same transaction. The seed's
    // clock is the neutral epoch: non-terminal pages never advance the
    // authoritative watermark.
    await prisma.$transaction((tx) => provenance.persistGaps(tx, provenanceScopeAt(older), [observation]));
    await expect(validationGap()).resolves.toMatchObject({ resolvedAt: null, lastSeenAt: older });
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({ where: summaryWhere }))
      .resolves.toMatchObject({ evaluatedAt: new Date(0), clearedAt: older });

    // The newer evaluation of an empty scripts scope commits first.
    const fresh = await prisma.$transaction((tx) => completeness.recalculate(tx, scopeAt(newer)));
    expect(fresh.applied).toBe(true);
    expect(fresh.counts.missing).toBe(10);
    const summaryAfterNewer = await prisma.integrationReconstructionSummary
      .findUniqueOrThrow({ where: summaryWhere });
    expect(summaryAfterNewer.evaluatedAt).toEqual(newer);
    const gapsAfterNewer = await completenessGaps();
    expect(gapsAfterNewer).toHaveLength(10);
    expect(gapsAfterNewer.every((gap) => gap.resolvedAt === null)).toBe(true);

    // The older run replays after it: nothing may move backward.
    const stale = await prisma.$transaction((tx) => completeness.recalculate(tx, scopeAt(older)));
    expect(stale.applied).toBe(false);
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({ where: summaryWhere }))
      .resolves.toMatchObject({ evaluatedAt: newer, counts: summaryAfterNewer.counts as object });
    await expect(completenessGaps()).resolves.toEqual(gapsAfterNewer);

    // A stale non-participant clear may not delete the newer scorecard
    // or resolve the gaps the newer evaluation refreshed.
    await prisma.$transaction((tx) => completeness.clearNonParticipant(tx, scopeAt(older)));
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({ where: summaryWhere }))
      .resolves.toMatchObject({ evaluatedAt: newer });
    await expect(completenessGaps()).resolves.toEqual(gapsAfterNewer);

    // Provenance-side gaps follow the same clock: a page write from an
    // older run cannot reopen a gap a newer sweep resolved, while a
    // genuinely newer observation still reopens it.
    await prisma.$transaction((tx) => provenance.resolveAbsentGaps(tx, provenanceScopeAt(newer)));
    await expect(validationGap()).resolves.toMatchObject({ resolvedAt: newer });
    await prisma.$transaction((tx) => provenance.persistGaps(tx, provenanceScopeAt(older), [observation]));
    await expect(validationGap()).resolves.toMatchObject({ resolvedAt: newer, lastSeenAt: older });
    await prisma.$transaction((tx) => provenance.persistGaps(tx, provenanceScopeAt(newest), [observation]));
    await expect(validationGap()).resolves
      .toMatchObject({ resolvedAt: null, lastSeenAt: newest, firstSeenAt: older });

    // A genuinely newer non-participant clear still wins: the scorecard
    // becomes a tombstone (never deleted — `evaluatedAt` must survive as
    // the scope's evaluation clock), completeness gaps are resolved,
    // provenance gaps untouched.
    await prisma.$transaction((tx) => completeness.clearNonParticipant(tx, scopeAt(newest)));
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({ where: summaryWhere }))
      .resolves.toMatchObject({ clearedAt: newest, evaluatedAt: newest, counts: {} });
    const clearedGaps = await completenessGaps();
    expect(clearedGaps.every((gap) => gap.resolvedAt?.getTime() === newest.getTime())).toBe(true);
    await expect(validationGap()).resolves.toMatchObject({ resolvedAt: null });

    // The tombstone keeps the clock: a stale recalculation arriving after
    // the clear must not resurrect a scorecard or reopen resolved gaps.
    const afterClear = await prisma.$transaction((tx) => completeness.recalculate(tx, scopeAt(older)));
    expect(afterClear.applied).toBe(false);
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({ where: summaryWhere }))
      .resolves.toMatchObject({ clearedAt: newest, evaluatedAt: newest });
    await expect(completenessGaps()).resolves.toEqual(clearedGaps);

    // The tombstone is also the insert watermark: a first observation
    // from a stale snapshot cannot create an open gap a newer completed
    // sweep already disproved, while a genuinely newer observation can.
    const beyondNewest = new Date('2026-07-20T13:00:00.000Z');
    const lateObservation = {
      externalId: `${ORG_A}:scripts:script-late`,
      syncRecordId: null,
      kind: 'validation' as const,
      message: 'Late observation requires operator review.',
      details: { reasonCode: 'schema_mismatch' },
    };
    await prisma.$transaction((tx) => provenance.persistGaps(tx, provenanceScopeAt(older), [lateObservation]));
    await expect(prisma.integrationReconstructionGap.count({
      where: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.scripts,
        message: 'Late observation requires operator review.',
      },
    })).resolves.toBe(0);
    await prisma.$transaction((tx) => provenance.persistGaps(tx, provenanceScopeAt(beyondNewest), [lateObservation]));
    await expect(prisma.integrationReconstructionGap.findFirstOrThrow({
      where: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.scripts,
        message: 'Late observation requires operator review.',
      },
    })).resolves.toMatchObject({
      resolvedAt: null,
      firstSeenAt: beyondNewest,
      lastSeenAt: beyondNewest,
      details: { reasonCode: 'schema_mismatch' },
    });
  }, 30_000);

  it('queues overlapping transactions on the scope watermark lock in both interleavings', async () => {
    const completeness = new IntegrationCompletenessService(prisma as never);
    const compScopeAt = (evaluatedAt: Date) => ({
      companyId: ids.companyA,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.scripts,
      evaluatedAt,
    });
    const provScopeAt = (observedAt: Date) => ({
      companyId: ids.companyA,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.scripts,
      observedAt,
    });
    const observationAt = (externalRef: string, message: string) => ({
      externalId: `${ORG_A}:scripts:${externalRef}`,
      syncRecordId: null,
      kind: 'validation' as const,
      message,
      details: { reasonCode: 'schema_mismatch' },
    });
    const gapByMessage = (message: string) => prisma.integrationReconstructionGap.findFirst({
      where: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.scripts,
        message,
      },
    });
    const txOptions = { maxWait: 10_000, timeout: 20_000 };
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    // Seed the watermark so the scope has a lockable summary row.
    const base = new Date('2026-07-21T10:00:00.000Z');
    await prisma.$transaction((tx) => completeness.recalculate(tx, compScopeAt(base)));

    // Interleaving 1: a newer sweep holds the watermark lock,
    // uncommitted. A stale first observation must queue behind it and
    // then see the committed advanced watermark — never the stale
    // pre-sweep value its snapshot would have shown without the lock.
    const older = new Date('2026-07-21T10:30:00.000Z');
    const newer = new Date('2026-07-21T11:00:00.000Z');
    const staleMessage = 'Overlap observation requires operator review.';
    const order: string[] = [];
    let releaseSweep!: () => void;
    const sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve; });
    let markSweepParked!: () => void;
    const sweepParked = new Promise<void>((resolve) => { markSweepParked = resolve; });
    const sweep = prisma.$transaction(async (tx) => {
      await provenance.resolveAbsentGaps(tx, provScopeAt(newer));
      await completeness.recalculate(tx, compScopeAt(newer));
      markSweepParked();
      await sweepGate;
    }, txOptions).then(() => order.push('sweep-committed'));
    await sweepParked;
    const staleInsert = prisma.$transaction(
      (tx) => provenance.persistGaps(tx, provScopeAt(older), [observationAt('script-overlap-stale', staleMessage)]),
      txOptions,
    ).then(() => order.push('stale-insert-committed'));
    await settle(400);
    // Still blocked on the watermark lock: without it, the stale insert
    // would already have committed an open gap the in-flight sweep can
    // no longer see.
    expect(order).toEqual([]);
    releaseSweep();
    await Promise.all([sweep, staleInsert]);
    expect(order).toEqual(['sweep-committed', 'stale-insert-committed']);
    await expect(gapByMessage(staleMessage)).resolves.toBeNull();

    // Interleaving 2: the observation holds the lock first, so the
    // terminal sweep queues behind it and its resolution scan sees the
    // committed row instead of missing a mid-flight insert.
    const observed = new Date('2026-07-21T12:00:00.000Z');
    const sweepAt = new Date('2026-07-21T13:00:00.000Z');
    const freshMessage = 'Queued observation requires operator review.';
    const secondOrder: string[] = [];
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    let markInsertParked!: () => void;
    const insertParked = new Promise<void>((resolve) => { markInsertParked = resolve; });
    const heldInsert = prisma.$transaction(async (tx) => {
      await provenance.persistGaps(tx, provScopeAt(observed), [observationAt('script-overlap-queued', freshMessage)]);
      markInsertParked();
      await insertGate;
    }, txOptions).then(() => secondOrder.push('insert-committed'));
    await insertParked;
    const trailingSweep = prisma.$transaction(
      (tx) => provenance.resolveAbsentGaps(tx, provScopeAt(sweepAt)),
      txOptions,
    ).then(() => secondOrder.push('sweep-committed'));
    await settle(400);
    expect(secondOrder).toEqual([]);
    releaseInsert();
    await Promise.all([heldInsert, trailingSweep]);
    expect(secondOrder).toEqual(['insert-committed', 'sweep-committed']);
    await expect(gapByMessage(freshMessage)).resolves.toMatchObject({
      resolvedAt: sweepAt,
      lastSeenAt: observed,
    });
  }, 30_000);

  it('serializes even the very first evaluations of a scope by seeding the watermark row', async () => {
    const completeness = new IntegrationCompletenessService(prisma as never);
    const older = new Date('2026-07-22T10:00:00.000Z');
    const newer = new Date('2026-07-22T11:00:00.000Z');
    const scopeFor = (resourceId: string) => ({
      comp: (evaluatedAt: Date) => ({
        companyId: ids.companyA,
        integrationCompanyMappingId: ids.mappingA,
        resourceId,
        evaluatedAt,
      }),
      prov: (observedAt: Date) => ({
        companyId: ids.companyA,
        integrationCompanyMappingId: ids.mappingA,
        resourceId,
        observedAt,
      }),
      summaryWhere: { integrationCompanyMappingId_summaryKey: {
        integrationCompanyMappingId: ids.mappingA,
        summaryKey: resourceId,
      } },
      gapByMessage: (message: string) => prisma.integrationReconstructionGap.findFirst({
        where: { integrationCompanyMappingId: ids.mappingA, resourceId, message },
      }),
    });
    const observationAt = (externalRef: string, message: string) => ({
      externalId: `${ORG_A}:cold:${externalRef}`,
      syncRecordId: null,
      kind: 'validation' as const,
      message,
      details: { reasonCode: 'schema_mismatch' },
    });
    const txOptions = { maxWait: 10_000, timeout: 20_000 };
    const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    // Interleaving 1, virgin scope: the first-ever sweep seeds and holds
    // the watermark; a concurrent stale first observation must queue
    // behind it and then skip against the committed advanced watermark.
    const cold = scopeFor(ids.scripts);
    const staleMessage = 'Cold-start observation requires operator review.';
    const order: string[] = [];
    let releaseSweep!: () => void;
    const sweepGate = new Promise<void>((resolve) => { releaseSweep = resolve; });
    let markSweepParked!: () => void;
    const sweepParked = new Promise<void>((resolve) => { markSweepParked = resolve; });
    const sweep = prisma.$transaction(async (tx) => {
      await provenance.resolveAbsentGaps(tx, cold.prov(newer));
      await completeness.recalculate(tx, cold.comp(newer));
      markSweepParked();
      await sweepGate;
    }, txOptions).then(() => order.push('sweep-committed'));
    await sweepParked;
    const staleInsert = prisma.$transaction(
      (tx) => provenance.persistGaps(tx, cold.prov(older), [observationAt('stale', staleMessage)]),
      txOptions,
    ).then(() => order.push('stale-insert-committed'));
    await settle(400);
    expect(order).toEqual([]);
    releaseSweep();
    await Promise.all([sweep, staleInsert]);
    expect(order).toEqual(['sweep-committed', 'stale-insert-committed']);
    await expect(cold.gapByMessage(staleMessage)).resolves.toBeNull();
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({ where: cold.summaryWhere }))
      .resolves.toMatchObject({ evaluatedAt: newer, clearedAt: null });

    // Interleaving 2, second virgin scope: the first observation seeds
    // and holds the watermark; the first-ever sweep queues behind the
    // uncommitted seed (its own seed insert waits out the winner) and
    // then resolves the committed observation.
    const cold2 = scopeFor(ids.deviceRelationships);
    const queuedMessage = 'Cold-start queued observation requires operator review.';
    const secondOrder: string[] = [];
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((resolve) => { releaseInsert = resolve; });
    let markInsertParked!: () => void;
    const insertParked = new Promise<void>((resolve) => { markInsertParked = resolve; });
    const heldInsert = prisma.$transaction(async (tx) => {
      await provenance.persistGaps(tx, cold2.prov(older), [observationAt('queued', queuedMessage)]);
      markInsertParked();
      await insertGate;
    }, txOptions).then(() => secondOrder.push('insert-committed'));
    await insertParked;
    const trailingSweep = prisma.$transaction(
      (tx) => provenance.resolveAbsentGaps(tx, cold2.prov(newer)),
      txOptions,
    ).then(() => secondOrder.push('sweep-committed'));
    await settle(400);
    expect(secondOrder).toEqual([]);
    releaseInsert();
    await Promise.all([heldInsert, trailingSweep]);
    expect(secondOrder).toEqual(['insert-committed', 'sweep-committed']);
    await expect(cold2.gapByMessage(queuedMessage)).resolves.toMatchObject({
      resolvedAt: newer,
      lastSeenAt: older,
    });
    // The seed tombstone persists as the scope's serialization row —
    // invisible to readers, carrying the neutral epoch clock so it can
    // never reject a later terminal evaluation.
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({ where: cold2.summaryWhere }))
      .resolves.toMatchObject({ evaluatedAt: new Date(0), clearedAt: older });
  }, 30_000);

  it('lets a failed non-terminal page seed the lock without advancing the authoritative clock', async () => {
    const completeness = new IntegrationCompletenessService(prisma as never);
    // A run against a newer (possibly clock-skewed) snapshot observes a
    // gap on a virgin scope, seeds the watermark, and then the run dies
    // before any terminal evaluation.
    const failedRunSnapshot = new Date('2026-07-23T12:00:00.000Z');
    const validRunSnapshot = new Date('2026-07-23T09:00:00.000Z');
    const scopeIds = {
      companyId: ids.companyA,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.scripts,
    };
    const summaryWhere = { integrationCompanyMappingId_summaryKey: {
      integrationCompanyMappingId: ids.mappingA,
      summaryKey: ids.scripts,
    } };
    await prisma.$transaction((tx) => provenance.persistGaps(
      tx,
      { ...scopeIds, observedAt: failedRunSnapshot },
      [{
        externalId: `${ORG_A}:scripts:script-doomed`,
        syncRecordId: null,
        kind: 'validation' as const,
        message: 'Doomed-run observation requires operator review.',
        details: { reasonCode: 'schema_mismatch' },
      }],
    ));

    // A later legitimate authoritative run with an OLDER snapshot must
    // still claim the scorecard: the seed has no clock authority.
    const result = await prisma.$transaction(async (tx) => {
      await provenance.resolveAbsentGaps(tx, { ...scopeIds, observedAt: validRunSnapshot });
      return completeness.recalculate(tx, { ...scopeIds, evaluatedAt: validRunSnapshot });
    });
    expect(result.applied).toBe(true);
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({ where: summaryWhere }))
      .resolves.toMatchObject({ evaluatedAt: validRunSnapshot, clearedAt: null });
    // The doomed run's observation keeps its own row-level recency: a
    // sweep from an older snapshot must not resolve it.
    await expect(prisma.integrationReconstructionGap.findFirstOrThrow({
      where: { ...scopeIds, message: 'Doomed-run observation requires operator review.' },
    })).resolves.toMatchObject({ resolvedAt: null, lastSeenAt: failedRunSnapshot });
  }, 30_000);

  it('fails closed on inconsistent tenant scope instead of locking or seeding across companies', async () => {
    const completeness = new IntegrationCompletenessService(prisma as never);
    const evaluatedAt = new Date('2026-07-23T10:00:00.000Z');
    const observedAt = new Date('2026-07-23T10:30:00.000Z');
    const observation = {
      externalId: `${ORG_A}:scripts:script-cross-tenant`,
      syncRecordId: null,
      kind: 'validation' as const,
      message: 'Cross-tenant observation must never persist.',
      details: { reasonCode: 'schema_mismatch' },
    };
    // Legitimate watermark for company A's mapping.
    await prisma.$transaction((tx) => completeness.recalculate(tx, {
      companyId: ids.companyA,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.scripts,
      evaluatedAt,
    }));
    const summaryBefore = await prisma.integrationReconstructionSummary.findUniqueOrThrow({
      where: { integrationCompanyMappingId_summaryKey: {
        integrationCompanyMappingId: ids.mappingA,
        summaryKey: ids.scripts,
      } },
    });

    // Company B's id paired with company A's mapping: the scoped probe
    // finds nothing, the seed's mapping-binding guard blocks, and the
    // scoped re-lock fails closed — no foreign row locked, nothing
    // written.
    await expect(prisma.$transaction((tx) => provenance.persistGaps(tx, {
      companyId: ids.companyB,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.scripts,
      observedAt,
    }, [observation]))).rejects.toThrow('Reconstruction watermark scope mismatch.');
    await expect(prisma.integrationReconstructionGap.count({
      where: { message: observation.message },
    })).resolves.toBe(0);
    await expect(prisma.integrationReconstructionSummary.findUniqueOrThrow({
      where: { integrationCompanyMappingId_summaryKey: {
        integrationCompanyMappingId: ids.mappingA,
        summaryKey: ids.scripts,
      } },
    })).resolves.toMatchObject({
      companyId: ids.companyA,
      evaluatedAt: summaryBefore.evaluatedAt,
      updatedAt: summaryBefore.updatedAt,
    });

    // Same inconsistent pairing on a scope with no summary row at all:
    // the seed must not materialize a cross-scope row either.
    await expect(prisma.$transaction((tx) => provenance.persistGaps(tx, {
      companyId: ids.companyB,
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.deviceRelationships,
      observedAt,
    }, [observation]))).rejects.toThrow('Reconstruction watermark scope mismatch.');
    await expect(prisma.integrationReconstructionSummary.findUnique({
      where: { integrationCompanyMappingId_summaryKey: {
        integrationCompanyMappingId: ids.mappingA,
        summaryKey: ids.deviceRelationships,
      } },
    })).resolves.toBeNull();
  }, 30_000);
});

async function buildAssetWriter(prisma: PrismaClient, audit: AuditLogService) {
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
  return new AssetTargetWriter(assets);
}

function buildRealWriterRegistry(prisma: PrismaClient, audit: AuditLogService) {
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
  const articles = new ArticlesService(
    prisma as never,
    audit,
    { isStarred: jest.fn().mockResolvedValue(false) } as never,
    {} as never,
    relations,
  );
  const ipam = new IpamService(prisma as never, audit);
  const assetWriter = new AssetTargetWriter(assets);
  const subnetWriter = new SubnetTargetWriter(ipam);
  const reservationWriter = new IpReservationTargetWriter(ipam);
  const articleWriter = new ArticleTargetWriter(articles);
  const relationWriter = new RelationTargetWriter(relations);
  const writers = [
    assetWriter,
    subnetWriter,
    reservationWriter,
    articleWriter,
    relationWriter,
  ] as const;
  return {
    registry: new ReconstructionWriterRegistry(writers),
    writers,
    writerByKind: { assetWriter, subnetWriter, reservationWriter, articleWriter, relationWriter },
    services: { assets, articles, ipam, relations },
  };
}

function buildRunner(
  prisma: PrismaClient,
  audit: AuditLogService,
  provenance: IntegrationProvenanceService,
  driver: BreezeDriver,
  writer: ReconstructionWriterRegistry | { write: (...args: never[]) => Promise<unknown> },
) {
  const writers = writer instanceof ReconstructionWriterRegistry
    ? writer
    : { get: jest.fn().mockReturnValue(writer) };
  return new IntegrationSyncRunnerService(
    prisma as never,
    { values: {
      INTEGRATION_HTTP_TIMEOUT_MS: 5,
      INTEGRATION_HTTP_MAX_RETRIES: 0,
      INTEGRATION_HTTP_BACKOFF_MS: 0,
    } } as never,
    audit,
    { loadDriverContext: jest.fn().mockResolvedValue({
      config: { baseUrl: 'https://breeze.example.test' },
      secret: { apiKey: 'synthetic-test-key' },
    }) } as never,
    { get: jest.fn().mockReturnValue(driver) } as never,
    { execute: jest.fn() } as never,
    writers as never,
    provenance,
    new IntegrationCompletenessService(prisma as never),
    new FieldTypesRegistry(),
  );
}

async function createQueuedRun(prisma: PrismaClient, mode: 'incremental' | 'full') {
  const id = randomUUID();
  await prisma.integrationSyncRun.create({
    data: {
      id,
      integrationId: ids.integration,
      kind: 'manual',
      mode,
      status: 'queued',
      dryRun: false,
      triggeredBy: ids.actor,
    },
  });
  return id;
}

async function persistedDeviceState(prisma: PrismaClient) {
  const [asset, binding, checkpoint, activeGapCount, staleAuditCount] = await Promise.all([
    prisma.asset.findUniqueOrThrow({ where: { id: ids.deviceA } }),
    prisma.integrationSyncRecord.findUniqueOrThrow({ where: { id: ids.syncDevice } }),
    prisma.integrationSyncCheckpoint.findUnique({ where: {
      integrationCompanyMappingId_resourceId_mode: {
        integrationCompanyMappingId: ids.mappingA,
        resourceId: ids.devices,
        mode: 'incremental',
      },
    } }),
    prisma.integrationReconstructionGap.count({ where: {
      integrationCompanyMappingId: ids.mappingA,
      resourceId: ids.devices,
      resolvedAt: null,
    } }),
    prisma.auditLog.count({ where: {
      companyId: ids.companyA,
      action: 'integration.target.stale',
    } }),
  ]);
  return { asset, binding, checkpoint, activeGapCount, staleAuditCount };
}

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

function chainRecords(sourceUpdatedAt: string) {
  const site = {
    ...siteRecord(),
    id: CHAIN_SITE,
    siteId: CHAIN_SITE,
    name: 'Task11 chain site',
    sourceUpdatedAt,
  };
  const device = {
    ...deviceRecord(),
    id: CHAIN_DEVICE,
    siteId: CHAIN_SITE,
    hostname: 'task11-chain-device',
    displayName: 'Task11 chain device',
    sourceUpdatedAt,
  };
  const baseInventory = inventoryRecord();
  const interfaceId = randomUUID();
  const inventory = {
    ...baseInventory,
    id: CHAIN_DEVICE,
    deviceId: CHAIN_DEVICE,
    siteId: CHAIN_SITE,
    sourceUpdatedAt,
    interfaces: [{
      ...baseInventory.interfaces[0],
      id: interfaceId,
      name: 'Task11 chain Ethernet',
      macAddress: '00:11:22:77:88:99',
    }],
    addresses: [{
      ...baseInventory.addresses[0],
      id: CHAIN_ADDRESS,
      interfaceId,
      interfaceName: 'Task11 chain Ethernet',
      address: '10.77.88.10',
      subnetMask: '255.255.255.0',
      gateway: '10.77.88.1',
      dnsServers: ['10.77.88.2'],
    }],
  };
  const script = {
    ...scriptRecord(),
    id: CHAIN_SCRIPT,
    name: 'Task11 chain rebuild',
    content: 'dnf install task11-chain-package',
    sourceUpdatedAt,
  };
  const relationship = {
    ...relationshipRecord(),
    id: CHAIN_DEVICE,
    deviceId: CHAIN_DEVICE,
    siteId: CHAIN_SITE,
    sourceUpdatedAt,
    edges: [{
      key: 'task11-chain-site-device',
      type: 'site_device',
      from: { type: 'site', id: CHAIN_SITE },
      to: { type: 'device', id: CHAIN_DEVICE },
      metadata: {},
    }],
  };
  return { site, device, inventory, script, relationship };
}

function assetInput(externalId: string) {
  return {
    targetKind: 'asset' as const,
    externalId,
    source: {
      externalOrgId: ORG_A,
      resourceKey: 'devices',
      sourceId: externalId.split(':').at(-1)!,
      revision: REVISION,
      fingerprint: REVISION,
      updatedAt: UPDATED,
    },
    name: 'Cross-company guard probe',
    assetLayoutId: ids.layout,
    externalSource: `breeze:${ids.integration}`,
    matchKeyFieldIds: [],
    fieldValues: [],
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
    { id: ids.companyA, name: 'Task 11 Company A', slug: 'task11-company-a', notes: 'operator-preserved company notes', quickNotes: 'operator-preserved quick notes' },
    { id: ids.companyB, name: 'Task 11 Company B', slug: 'task11-company-b' },
  ] });
  await prisma.assetLayout.create({ data: { id: ids.layout, name: 'Task 11 Devices', slug: 'task11-devices', icon: 'server', color: '#000000', createdBy: ids.actor } });
  await prisma.assetField.create({ data: { id: ids.field, assetLayoutId: ids.layout, name: 'Reconstruction details', slug: 'reconstruction-details', fieldType: 'TEXTAREA', position: 0, isPrimary: true, options: {} } });
  await prisma.integration.create({ data: { id: ids.integration, driver: 'breeze', name: 'Task 11 Breeze', status: 'ACTIVE', config: { baseUrl: 'https://breeze.example.test' }, syncCron: '*/15 * * * *', createdBy: ids.actor } });
  await prisma.integrationResource.createMany({ data: [
    { id: ids.sites, integrationId: ids.integration, resourceKey: 'sites', targetKind: 'asset', assetLayoutId: ids.layout, targetConfig: {}, dependsOnResourceKeys: [] },
    { id: ids.devices, integrationId: ids.integration, resourceKey: 'devices', targetKind: 'asset', assetLayoutId: ids.layout, targetConfig: {}, dependsOnResourceKeys: [] },
    { id: ids.subnets, integrationId: ids.integration, resourceKey: 'subnets', targetKind: 'subnet', targetConfig: {}, dependsOnResourceKeys: ['devices'] },
    { id: ids.reservations, integrationId: ids.integration, resourceKey: 'ip-reservations', targetKind: 'ip_reservation', targetConfig: {}, dependsOnResourceKeys: ['subnets'] },
    { id: ids.scripts, integrationId: ids.integration, resourceKey: 'scripts', targetKind: 'article', targetConfig: {}, dependsOnResourceKeys: [] },
    { id: ids.deviceRelationships, integrationId: ids.integration, resourceKey: 'device-relationships', targetKind: 'relation', targetConfig: {}, dependsOnResourceKeys: ['sites', 'devices'] },
    { id: ids.articles, integrationId: ids.integration, resourceKey: 'articles', targetKind: 'article', targetConfig: {}, dependsOnResourceKeys: [] },
    { id: ids.relations, integrationId: ids.integration, resourceKey: 'relations', targetKind: 'relation', targetConfig: {}, dependsOnResourceKeys: ['devices', 'articles'] },
  ] });
  await prisma.integrationFieldMapping.createMany({
    data: [
      { resourceId: ids.sites, sourceField: 'name' },
      { resourceId: ids.devices, sourceField: 'hostname' },
    ].map(({ resourceId, sourceField }) => ({
      resourceId,
      sourceField,
      targetFieldId: ids.field,
      syncDirection: 'manual_only' as const,
    })),
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
  await prisma.subnet.create({ data: { id: ids.subnetB, companyId: ids.companyB, name: 'Company B LAN', cidr: '10.99.0.0/24', prefix: 24, gateway: '10.99.0.1', createdBy: ids.actor, updatedBy: ids.actor } });
  await prisma.ipReservation.create({ data: { id: ids.reservation, companyId: ids.companyA, subnetId: ids.subnet, ipAddress: '10.20.30.10', label: 'APP-01 static', createdBy: ids.actor, updatedBy: ids.actor } });
  await prisma.article.createMany({ data: [
    { id: ids.article, companyId: ids.companyA, title: 'APP-01 Rebuild', slug: 'app-01-rebuild', editorMode: 'markdown', markdownSource: '# APP-01 Rebuild\nInstall PostgreSQL and restore the database.', contentPlaintext: 'APP-01 Rebuild Install PostgreSQL and restore the database.', visibleToClients: false, createdBy: ids.actor, updatedBy: ids.actor },
    { id: ids.manualArticle, companyId: ids.companyA, title: 'Manual operating notes', slug: 'manual-operating-notes', editorMode: 'markdown', markdownSource: '# Manual notes\nPreserve this article.', contentPlaintext: 'Manual notes Preserve this article.', visibleToClients: false, createdBy: ids.actor, updatedBy: ids.actor },
    { id: ids.articleB, companyId: ids.companyB, title: 'Company B article', slug: 'company-b-article', editorMode: 'markdown', markdownSource: '# Company B', contentPlaintext: 'Company B', visibleToClients: false, createdBy: ids.actor, updatedBy: ids.actor },
  ] });
  await prisma.articleVersion.create({ data: { articleId: ids.article, companyId: ids.companyA, version: 1, title: 'APP-01 Rebuild', slug: 'app-01-rebuild', folderId: null, visibleToClients: false, editorMode: 'markdown', markdownSource: '# APP-01 Rebuild\nInstall PostgreSQL and restore the database.', contentPlaintext: 'APP-01 Rebuild Install PostgreSQL and restore the database.', changedBy: ids.actor } });
  await prisma.relation.createMany({ data: [
    { id: ids.relation, companyId: ids.companyA, sourceType: 'Asset', sourceId: ids.siteA, targetType: 'Asset', targetId: ids.deviceA, relationType: 'site_device', createdBy: ids.actor },
    { id: ids.manualRelation, companyId: ids.companyA, sourceType: 'Asset', sourceId: ids.deviceA, targetType: 'Article', targetId: ids.manualArticle, relationType: 'manual_dependency', createdBy: ids.actor },
    { id: ids.relationB, companyId: ids.companyB, sourceType: 'Asset', sourceId: ids.deviceB, targetType: 'Article', targetId: ids.articleB, relationType: 'company_b_dependency', createdBy: ids.actor },
  ] });
  await prisma.password.create({ data: { id: ids.password, companyId: ids.companyA, assetId: ids.deviceA, name: 'Manual administrator reference', username: 'admin', passwordCiphertext: 'test-ciphertext-not-a-secret', createdBy: ids.actor, updatedBy: ids.actor } });
  await prisma.upload.create({ data: { id: ids.upload, companyId: ids.companyA, uploaderId: ids.actor, filename: 'operator-runbook.txt', mimeType: 'text/plain', sizeBytes: 28, storageKey: `${ids.companyA}/uploads/${ids.upload}/operator-runbook.txt`, sha256: 'b'.repeat(64), attachedToType: 'asset', attachedToId: ids.deviceA } });
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
