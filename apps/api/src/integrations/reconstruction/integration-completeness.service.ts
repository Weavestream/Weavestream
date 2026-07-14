import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../../prisma/prisma.service.js';

export const COMPLETENESS_CAPABILITIES = [
  'administrative_credential',
  'installation_source',
  'license_activation',
  'physical_location',
  'ip_firewall',
  'backup_restore',
  'service_dependencies',
  'ordered_rebuild_steps',
  'post_restoration_validation',
  'vendor_escalation_contact',
] as const;

export type CompletenessCapability = (typeof COMPLETENESS_CAPABILITIES)[number];
export type CompletenessCategory =
  | 'synchronized_current'
  | 'manually_documented'
  | 'secret_blocked'
  | 'missing'
  | 'stale'
  | 'synchronization_error';

export interface CompletenessCounts {
  synchronizedCurrent: number;
  manuallyDocumented: number;
  secretBlocked: number;
  missing: number;
  stale: number;
  synchronizationError: number;
}

export interface CompletenessScope {
  companyId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  evaluatedAt: Date;
}

const MANAGED_START = '<!-- weavestream:breeze:managed:start -->';
const MANAGED_END = '<!-- weavestream:breeze:managed:end -->';
const EVIDENCE_PAGE_SIZE = 1_000;
const TARGET_ID_BATCH_SIZE = 500;
// The runner accepts at most 10,000 source records per resource traversal.
// Related native rows can fan out (fields, passwords, relations), so they use
// a separate bounded ceiling while still failing closed on pathological data.
const MAX_SYNC_RECORDS = 10_000;
const MAX_RELATED_ROWS = 50_000;

@Injectable()
export class IntegrationCompletenessService {
  constructor(private readonly prisma: PrismaService) {}

  async recalculate(
    tx: Prisma.TransactionClient,
    scope: CompletenessScope,
  ): Promise<{
    counts: CompletenessCounts;
    items: Array<{ capability: CompletenessCapability; category: CompletenessCategory }>;
  }> {
    const evidence = await this.collectEvidence(tx, scope);
    const items = COMPLETENESS_CAPABILITIES.map((capability) => ({
      capability,
      category: classify(capability, evidence),
    }));
    const counts = emptyCounts();
    for (const item of items) counts[countKey(item.category)] += 1;

    for (const item of items.filter((candidate) => candidate.category === 'missing')) {
      const dedupeKey = `completeness:${createHash('sha256').update(item.capability).digest('hex')}`;
      await tx.integrationReconstructionGap.upsert({
        where: {
          integrationCompanyMappingId_resourceId_dedupeKey: {
            integrationCompanyMappingId: scope.integrationCompanyMappingId,
            resourceId: scope.resourceId,
            dedupeKey,
          },
        },
        create: {
          companyId: scope.companyId,
          integrationCompanyMappingId: scope.integrationCompanyMappingId,
          resourceId: scope.resourceId,
          syncRecordId: null,
          dedupeKey,
          kind: 'unsupported',
          message: `Document the missing ${displayCapability(item.capability)} requirement.`,
          details: { unsupportedCapability: item.capability },
          firstSeenAt: scope.evaluatedAt,
          lastSeenAt: scope.evaluatedAt,
          resolvedAt: null,
        },
        update: {
          message: `Document the missing ${displayCapability(item.capability)} requirement.`,
          details: { unsupportedCapability: item.capability },
          lastSeenAt: scope.evaluatedAt,
          resolvedAt: null,
        },
      });
    }
    await tx.integrationReconstructionGap.updateMany({
      where: {
        companyId: scope.companyId,
        integrationCompanyMappingId: scope.integrationCompanyMappingId,
        resourceId: scope.resourceId,
        resolvedAt: null,
        dedupeKey: { startsWith: 'completeness:' },
        lastSeenAt: { lt: scope.evaluatedAt },
      },
      data: { resolvedAt: scope.evaluatedAt },
    });
    await tx.integrationReconstructionSummary.upsert({
      where: {
        integrationCompanyMappingId_summaryKey: {
          integrationCompanyMappingId: scope.integrationCompanyMappingId,
          summaryKey: scope.resourceId,
        },
      },
      create: {
        companyId: scope.companyId,
        integrationCompanyMappingId: scope.integrationCompanyMappingId,
        resourceId: scope.resourceId,
        summaryKey: scope.resourceId,
        counts: counts as unknown as Prisma.InputJsonValue,
        evaluatedAt: scope.evaluatedAt,
        lastSuccessfulSyncAt: scope.evaluatedAt,
      },
      update: {
        counts: counts as unknown as Prisma.InputJsonValue,
        evaluatedAt: scope.evaluatedAt,
        lastSuccessfulSyncAt: scope.evaluatedAt,
      },
    });
    return { counts, items };
  }

  private async collectEvidence(
    tx: Prisma.TransactionClient,
    scope: CompletenessScope,
  ): Promise<Evidence> {
    const records = await collectPaged(
      (cursor) => tx.integrationSyncRecord.findMany({
        where: {
          companyId: scope.companyId,
          integrationCompanyMappingId: scope.integrationCompanyMappingId,
          resourceId: scope.resourceId,
        },
        select: {
          id: true,
          state: true,
          targetKind: true,
          assetId: true,
          subnetId: true,
          ipReservationId: true,
          articleId: true,
          relationId: true,
          lastSyncedFieldChecksums: true,
          provenance: true,
        },
        orderBy: { id: 'asc' },
        take: EVIDENCE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      }),
      'sync records',
      MAX_SYNC_RECORDS,
    );
    const assetIds = compact(records.map((record) => record.assetId));
    const articleIds = compact(records.map((record) => record.articleId));
    const relationIds = compact(records.map((record) => record.relationId));
    const subnetIds = compact(records.map((record) => record.subnetId));
    const reservationIds = compact(records.map((record) => record.ipReservationId));

    const relevantEndpointIds = compact([
      ...assetIds, ...articleIds, ...subnetIds, ...reservationIds,
    ]);
    const [fieldValues, boundRelations, endpointRelations, subnets, reservations, passwords] = await Promise.all([
      collectChunked(assetIds, 'asset fields', (ids, cursor) => tx.assetFieldValue.findMany({
        where: { companyId: scope.companyId, assetId: { in: ids } },
        select: { id: true, assetId: true, assetFieldId: true, value: true, assetField: { select: { slug: true } } },
        orderBy: { id: 'asc' }, take: EVIDENCE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })),
      collectChunked(relationIds, 'bound relations', (ids, cursor) => tx.relation.findMany({
        where: { companyId: scope.companyId, id: { in: ids } },
        select: {
          id: true, relationType: true, sourceType: true, sourceId: true,
          targetType: true, targetId: true,
        },
        orderBy: { id: 'asc' }, take: EVIDENCE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })),
      collectChunked(relevantEndpointIds, 'endpoint relations', (ids, cursor) => tx.relation.findMany({
        where: {
          companyId: scope.companyId,
          OR: [{ sourceId: { in: ids } }, { targetId: { in: ids } }],
        },
        select: {
          id: true, relationType: true, sourceType: true, sourceId: true,
          targetType: true, targetId: true,
        },
        orderBy: { id: 'asc' }, take: EVIDENCE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })),
      collectChunked(subnetIds, 'subnets', (ids, cursor) => tx.subnet.findMany({
        where: { companyId: scope.companyId, id: { in: ids } },
        select: { id: true, description: true, archivedAt: true },
        orderBy: { id: 'asc' }, take: EVIDENCE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })),
      collectChunked(reservationIds, 'reservations', (ids, cursor) => tx.ipReservation.findMany({
        where: { companyId: scope.companyId, id: { in: ids } },
        select: { id: true, notes: true },
        orderBy: { id: 'asc' }, take: EVIDENCE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })),
      collectChunked(assetIds, 'password references', (ids, cursor) => tx.password.findMany({
        where: { companyId: scope.companyId, assetId: { in: ids }, archivedAt: null },
        select: { id: true, assetId: true },
        orderBy: { id: 'asc' }, take: EVIDENCE_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })),
    ]);
    const relations = dedupeRows([...boundRelations, ...endpointRelations], 'relations');
    const endpointKeySet = new Set([
      ...assetIds.map((id) => endpointKey('Asset', id)),
      ...articleIds.map((id) => endpointKey('Article', id)),
      ...subnetIds.map((id) => endpointKey('Subnet', id)),
      ...reservationIds.map((id) => endpointKey('IpReservation', id)),
    ]);
    const linkedManualArticleIds = new Set<string>();
    for (const relation of relations) {
      if (
        endpointKeySet.has(endpointKey(relation.sourceType, relation.sourceId)) &&
        normalizeEndpointType(relation.targetType) === 'article'
      ) {
        linkedManualArticleIds.add(relation.targetId);
      }
      if (
        endpointKeySet.has(endpointKey(relation.targetType, relation.targetId)) &&
        normalizeEndpointType(relation.sourceType) === 'article'
      ) {
        linkedManualArticleIds.add(relation.sourceId);
      }
    }
    const scopedArticleIds = compact([...articleIds, ...linkedManualArticleIds]);
    const articles = await collectChunked(scopedArticleIds, 'articles', (ids, cursor) => tx.article.findMany({
      where: { companyId: scope.companyId, id: { in: ids } },
      select: { id: true, markdownSource: true, contentPlaintext: true, archivedAt: true },
      orderBy: { id: 'asc' }, take: EVIDENCE_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }));

    const active = new Set<CompletenessCapability>();
    const manual = new Set<CompletenessCapability>();
    const stale = new Set<CompletenessCapability>();
    const recordByAsset = new Map(records.filter((record) => record.assetId).map((record) => [record.assetId!, record]));
    for (const field of fieldValues) {
      if (!hasValue(field.value)) continue;
      const capability = capabilityForText(field.assetField.slug);
      if (!capability) continue;
      const record = recordByAsset.get(field.assetId);
      const checksums = jsonObject(record?.lastSyncedFieldChecksums);
      if (!record || !(field.assetFieldId in checksums)) manual.add(capability);
      else {
        const allowed = sourceCapabilities(jsonObject(record.provenance)['resourceKey']);
        if (!allowed.has(capability)) continue;
        if (record.state === 'active') active.add(capability);
        else if (record.state === 'stale') stale.add(capability);
      }
    }

    const recordByArticle = new Map(records.filter((record) => record.articleId).map((record) => [record.articleId!, record]));
    const scopedArticleIdSet = new Set(scopedArticleIds);
    for (const article of articles) {
      if (!scopedArticleIdSet.has(article.id)) continue;
      const record = recordByArticle.get(article.id);
      const markdown = article.markdownSource ?? article.contentPlaintext ?? '';
      const { managed, manual: manualText } = splitManaged(markdown);
      const resourceKey = jsonObject(record?.provenance)['resourceKey'];
      for (const capability of sourceManagedCapabilities(resourceKey, managed)) {
        if (!record) continue;
        if (record.state === 'active') active.add(capability);
        else if (record.state === 'stale') stale.add(capability);
      }
      // Manual text belongs to the operator, not Breeze. Preserve it when an
      // exact bound source article becomes stale/soft-archived; only unrelated
      // manually archived articles are ineligible.
      if (article.archivedAt === null || record) {
        for (const capability of capabilitiesForText(manualText)) manual.add(capability);
      }
    }

    const relationIdSet = new Set(relationIds);
    for (const relation of relations) {
      if (relationIdSet.has(relation.id)) {
        const record = records.find((candidate) => candidate.relationId === relation.id);
        (record?.state === 'stale' ? stale : active).add('service_dependencies');
      } else if (
        endpointKeySet.has(endpointKey(relation.sourceType, relation.sourceId)) ||
        endpointKeySet.has(endpointKey(relation.targetType, relation.targetId))
      ) {
        manual.add('service_dependencies');
      }
    }
    if (passwords.length > 0) manual.add('administrative_credential');

    for (const subnet of subnets) {
      if (!/firewall/i.test(subnet.description ?? '')) continue;
      const record = records.find((candidate) => candidate.subnetId === subnet.id);
      (record?.state === 'stale' ? stale : active).add('ip_firewall');
    }
    for (const reservation of reservations) {
      if (!/firewall/i.test(reservation.notes ?? '')) continue;
      const record = records.find((candidate) => candidate.ipReservationId === reservation.id);
      (record?.state === 'stale' ? stale : active).add('ip_firewall');
    }

    const gaps = await tx.integrationReconstructionGap.findMany({
      where: {
        companyId: scope.companyId,
        integrationCompanyMappingId: scope.integrationCompanyMappingId,
        resourceId: scope.resourceId,
        resolvedAt: null,
      },
      select: { kind: true, details: true },
      orderBy: { id: 'asc' },
      take: 1_001,
    });
    if (gaps.length > 1_000) throw new BadRequestException('Completeness gaps exceeded the bounded limit.');
    const secretBlocked = new Set<CompletenessCapability>();
    const synchronizationError = new Set<CompletenessCapability>();
    for (const gap of gaps) {
      const details = jsonObject(gap.details);
      const explicit = parseCapability(details['unsupportedCapability']);
      const capabilities = explicit ? [explicit] : [...gapCapabilities(details['sourceResource'])];
      for (const capability of capabilities) {
        if (gap.kind === 'secret_blocked') secretBlocked.add(capability);
        if (gap.kind === 'synchronization_error') synchronizationError.add(capability);
      }
    }
    return { active, manual, stale, secretBlocked, synchronizationError };
  }
}

interface Evidence {
  active: Set<CompletenessCapability>;
  manual: Set<CompletenessCapability>;
  stale: Set<CompletenessCapability>;
  secretBlocked: Set<CompletenessCapability>;
  synchronizationError: Set<CompletenessCapability>;
}

function classify(capability: CompletenessCapability, evidence: Evidence): CompletenessCategory {
  if (evidence.active.has(capability)) return 'synchronized_current';
  if (evidence.manual.has(capability)) return 'manually_documented';
  if (evidence.secretBlocked.has(capability)) return 'secret_blocked';
  if (evidence.synchronizationError.has(capability)) return 'synchronization_error';
  if (evidence.stale.has(capability)) return 'stale';
  return 'missing';
}

function countKey(category: CompletenessCategory): keyof CompletenessCounts {
  return {
    synchronized_current: 'synchronizedCurrent',
    manually_documented: 'manuallyDocumented',
    secret_blocked: 'secretBlocked',
    missing: 'missing',
    stale: 'stale',
    synchronization_error: 'synchronizationError',
  }[category] as keyof CompletenessCounts;
}

function emptyCounts(): CompletenessCounts {
  return {
    synchronizedCurrent: 0, manuallyDocumented: 0, secretBlocked: 0,
    missing: 0, stale: 0, synchronizationError: 0,
  };
}

const CAPABILITY_PATTERNS: Array<[CompletenessCapability, RegExp]> = [
  ['administrative_credential', /administrative[-_ ]credential|credential[-_ ]reference/i],
  ['installation_source', /install(?:ation)?[-_ ](?:source|media)|download[-_ ]source/i],
  ['license_activation', /licen[cs]e|activation|product[-_ ]key/i],
  ['physical_location', /physical[-_ ]location|rack|room|site[-_ ]location|address[-_ ]line|postal[-_ ]code/i],
  ['ip_firewall', /firewall[-_ ]rules?|ip[-_ ]firewall/i],
  ['backup_restore', /backup[\s\S]*(?:restore|restoration)|(?:restore|restoration)[\s\S]*backup/i],
  ['service_dependencies', /service[-_ ]dependenc|data[-_ ]dependenc|depends[-_ ]on/i],
  ['ordered_rebuild_steps', /ordered[-_ ]rebuild|rebuild[-_ ]steps?|rebuild procedure/i],
  ['post_restoration_validation', /post[-_ ](?:restoration|restore|build)[-_ ]validation|validation[-_ ]steps?/i],
  ['vendor_escalation_contact', /vendor[-_ ]contact|escalation[-_ ]contact|support[-_ ]contact/i],
];

function capabilityForText(text: string): CompletenessCapability | null {
  return CAPABILITY_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function capabilitiesForText(text: string): CompletenessCapability[] {
  return CAPABILITY_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([capability]) => capability);
}

const SOURCE_CAPABILITIES: Record<string, readonly CompletenessCapability[]> = {
  sites: ['physical_location'],
};

const GAP_CAPABILITIES: Record<string, readonly CompletenessCapability[]> = {
  sites: ['physical_location'],
  scripts: ['ordered_rebuild_steps'],
  automations: ['ordered_rebuild_steps', 'service_dependencies'],
  'automation-relations': ['service_dependencies'],
  'configuration-assignment-relations': ['service_dependencies'],
  'backup-configurations': ['backup_restore'],
  'backup-configuration-relations': ['service_dependencies'],
  'device-relationships': ['service_dependencies'],
  subnets: ['ip_firewall'],
  'ip-reservations': ['ip_firewall'],
};

function sourceCapabilities(resourceKey: unknown): Set<CompletenessCapability> {
  return new Set(typeof resourceKey === 'string' ? SOURCE_CAPABILITIES[resourceKey] ?? [] : []);
}

function sourceManagedCapabilities(resourceKey: unknown, markdown: string): Set<CompletenessCapability> {
  const capabilities = new Set<CompletenessCapability>();
  if (resourceKey === 'scripts') {
    if (/## Rebuild-safe content[^\n]*\n`{3,}[^\n]*\n(?!`{3,})\S[\s\S]*?\n`{3,}/i.test(markdown)) {
      capabilities.add('ordered_rebuild_steps');
    }
    if (/post-(?:build|restoration) validation(?: step)?s?\s*:\s*(?!not exported|none|missing)\S/i.test(markdown)) {
      capabilities.add('post_restoration_validation');
    }
  }
  if (resourceKey === 'automations') {
    if (/## Ordered actions[^\n]*\n(?:\s*\n)*1\./i.test(markdown)) capabilities.add('ordered_rebuild_steps');
    if (/## Script dependencies[^\n]*\n- [0-9a-f-]{36}/i.test(markdown)) capabilities.add('service_dependencies');
  }
  if (resourceKey === 'backup-configurations') {
    const hasDestination = /Destination UUID:\s*[0-9a-f-]{36}/i.test(markdown);
    const hasInstructions = /"notes":"(?!null|none|not exported|missing)[^"\r\n]+"/i.test(markdown);
    if (hasDestination && hasInstructions) capabilities.add('backup_restore');
  }
  return capabilities;
}

function gapCapabilities(resourceKey: unknown): Set<CompletenessCapability> {
  return new Set(typeof resourceKey === 'string' ? GAP_CAPABILITIES[resourceKey] ?? [] : []);
}

function splitManaged(markdown: string): { managed: string; manual: string } {
  const start = markdown.indexOf(MANAGED_START);
  const end = markdown.indexOf(MANAGED_END);
  if (start < 0 || end < start) return { managed: '', manual: markdown };
  return {
    managed: markdown.slice(start + MANAGED_START.length, end),
    manual: `${markdown.slice(0, start)}\n${markdown.slice(end + MANAGED_END.length)}`,
  };
}

function compact(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))];
}

function normalizeEndpointType(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function endpointKey(type: string, id: string): string {
  return `${normalizeEndpointType(type)}:${id}`;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

function parseCapability(value: unknown): CompletenessCapability | null {
  return typeof value === 'string' && (COMPLETENESS_CAPABILITIES as readonly string[]).includes(value)
    ? value as CompletenessCapability
    : null;
}

async function collectPaged<T extends { id: string }>(
  fetchPage: (cursor?: string) => Promise<T[]>,
  name: string,
  hardLimit = MAX_RELATED_ROWS,
): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  while (true) {
    const page = await fetchPage(cursor);
    rows.push(...page);
    if (rows.length > hardLimit) {
      throw new BadRequestException(`Completeness ${name} exceeded the bounded limit.`);
    }
    if (page.length < EVIDENCE_PAGE_SIZE) return rows;
    const nextCursor = page.at(-1)?.id;
    if (!nextCursor || nextCursor === cursor) {
      throw new BadRequestException(`Completeness ${name} pagination did not advance.`);
    }
    cursor = nextCursor;
  }
}

async function collectChunked<T extends { id: string }>(
  ids: string[],
  name: string,
  fetchPage: (ids: string[], cursor?: string) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += TARGET_ID_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + TARGET_ID_BATCH_SIZE);
    rows.push(...await collectPaged(
      (cursor) => fetchPage(chunk, cursor),
      name,
      MAX_RELATED_ROWS,
    ));
    if (rows.length > MAX_RELATED_ROWS) {
      throw new BadRequestException(`Completeness ${name} exceeded the bounded limit.`);
    }
  }
  return rows;
}

function dedupeRows<T extends { id: string }>(rows: T[], name: string): T[] {
  const deduped = [...new Map(rows.map((row) => [row.id, row])).values()];
  if (deduped.length > MAX_RELATED_ROWS) {
    throw new BadRequestException(`Completeness ${name} exceeded the bounded limit.`);
  }
  return deduped;
}

function displayCapability(capability: CompletenessCapability): string {
  return capability.replaceAll('_', ' ');
}
