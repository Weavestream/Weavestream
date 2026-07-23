import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  integrationProvenanceSchema,
  ipInCidr,
  normalizeIpv4V4,
  reconstructionCompletenessCountsSchema,
  type IntegrationSyncState,
  type IntegrationTargetKind,
  type ReconstructionCompletenessCounts,
  type ReconstructionGapKind,
} from '@weavestream/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  SecretEncryptionService,
  passwordVaultAad,
} from '../crypto/secret-encryption.service.js';
import { extractEmbeddedUploadIds } from '../articles/article-uploads.js';
import { scanSensitiveMaterial } from '../integrations/sensitive-material.js';

// ---------------------------------------------------------------------------
// Export data shapes
// ---------------------------------------------------------------------------

export interface ExportCompany {
  id: string;
  name: string;
  slug: string;
  type: string;
  quickNotes: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  generalEmail: string | null;
  phone: string | null;
  fax: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  parentName: string | null;
  createdAt: Date;
}

export interface ExportMember {
  name: string;
  email: string;
  role: string;
  expiresAt: Date | null;
}

export interface ExportAssetField {
  label: string;
  fieldType: string;
  value: unknown;
  /**
   * UUID → display name lookup populated for fields whose stored value is an
   * array of foreign-key ids (`ASSET_REFERENCE` → `Asset.name`,
   * `TAGS` → `Tag.name`). Lets the PDF formatter render readable text without
   * re-querying.
   */
  referenceLabels?: Record<string, string>;
}

export interface ExportAsset {
  name: string;
  layoutName: string;
  fields: ExportAssetField[];
  reconstructionState?: ExportReconstructionState;
}

export interface ExportReconstructionState {
  state: 'stale';
  staleSince: Date;
  sourceLabel: string;
}

export interface ExportPassword {
  name: string;
  username: string | null;
  url: string | null;
  folderPath: string;
  tags: string[];
  password: string | null;
  notes: unknown | null;
  totpSecret: string | null;
  lastRotatedAt: Date | null;
  expiresAt: Date | null;
  pwnedCount: number | null;
}

export interface ExportArticle {
  id: string;
  title: string;
  folderPath: string;
  editorMode: 'tiptap' | 'markdown';
  content: Prisma.JsonValue | null;
  markdownSource: string | null;
  contentPlaintext: string | null;
  images: ExportArticleImage[];
  updatedAt: Date;
  reconstructionState?: ExportReconstructionState;
}

export interface ExportArticleImage {
  uploadId: string;
  filename: string;
  mimeType: string;
  storageKey: string;
  /**
   * Stored dimensions from upload confirm, used by the PDF-export
   * decompression-bomb gate (WS-027). Null when sharp could not read the
   * image header — the gate fails closed on those rows.
   */
  width: number | null;
  height: number | null;
  data?: Buffer;
}

export interface ExportDomain {
  hostname: string;
  latestStatus: string;
  whoisExpiresAt: Date | null;
  tlsExpiresAt: Date | null;
  lastCheckedAt: Date | null;
}

export interface ExportUpload {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
}

export interface ExportIpReservation {
  ipAddress: string;
  label: string;
  notes: string | null;
}

export interface ExportSubnetOccupant {
  ipAddress: string;
  assetLabel: string;
  interfaceLabel: string;
  assetHref: string;
}

export interface ExportSubnet {
  name: string;
  cidr: string;
  prefix: number;
  vlanId: number | null;
  gateway: string | null;
  dhcpRangeStart: string | null;
  dhcpRangeEnd: string | null;
  description: string | null;
  reservations: ExportIpReservation[];
  occupants: ExportSubnetOccupant[];
  reconstructionState?: ExportReconstructionState;
}

export interface ExportRelationEndpoint {
  kind: 'asset' | 'article' | 'password';
  label: string;
  href: string;
}

export interface ExportRelation {
  relationType: string;
  source: ExportRelationEndpoint;
  target: ExportRelationEndpoint;
  createdAt: Date;
  reconstructionState?: ExportReconstructionState;
}

export interface ExportNativeTarget {
  kind: IntegrationTargetKind;
  label: string;
  href: string | null;
}

export interface ExportReconstructionSummary {
  resourceKey: string;
  resourceLabel: string;
  counts: ReconstructionCompletenessCounts;
  evaluatedAt: Date;
  lastSuccessfulSyncAt: Date | null;
}

export interface ExportSafeReconstructionGap {
  resourceKey: string;
  resourceLabel: string;
  kind: ReconstructionGapKind;
  message: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  target: ExportNativeTarget | null;
}

export interface ExportSourceProvenance {
  sourceLabel: string;
  sourceResource: string;
  ownership: 'breeze' | 'weavestream';
  state: IntegrationSyncState;
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSyncedAt: Date | null;
  staleSince: Date | null;
  target: ExportNativeTarget;
}

export const COMPANY_EXPORT_LIMITS = {
  subnets: 10_000,
  reservations: 50_000,
  occupants: 50_000,
  relations: 50_000,
  reconstructionSummaries: 10_000,
  reconstructionGaps: 10_000,
  provenance: 50_000,
  ipamMembershipChecks: 5_000_000,
} as const;

export interface CompanyExportData {
  /** Instance workspace name (admin Settings → Workspace name). */
  workspaceName: string;
  company: ExportCompany;
  members: ExportMember[];
  assets: ExportAsset[];
  passwords: ExportPassword[];
  articles: ExportArticle[];
  domains: ExportDomain[];
  uploads: ExportUpload[];
  ipam: ExportSubnet[];
  relations: ExportRelation[];
  reconstruction: {
    summaries: ExportReconstructionSummary[];
    gaps: ExportSafeReconstructionGap[];
    provenance: ExportSourceProvenance[];
  };
  exportedAt: Date;
  includePasswords: boolean;
}

interface SafeSyncBinding {
  targetKind: IntegrationTargetKind;
  targetId: string;
  integrationCompanyMappingId: string;
  resourceId: string;
  state: IntegrationSyncState;
  staleSince: Date | null;
  driver: string;
  sourceLabel: string;
  resourceKey: string;
  ownership: 'breeze' | 'weavestream';
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastSyncedAt: Date | null;
  target: ExportNativeTarget;
}

interface SafeSyncBindingIndex {
  all: SafeSyncBinding[];
  byTarget: Map<string, SafeSyncBinding[]>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class CompanyExportDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretEncryptionService,
  ) {}

  async gather(
    companyId: string,
    opts: { includePasswords: boolean },
  ): Promise<CompanyExportData> {
    const bindings = await this.fetchSafeSyncBindings(companyId);
    const [
      company,
      workspaceName,
      memberships,
      assets,
      articles,
      passwords,
      domains,
      uploads,
      ipam,
      relations,
      reconstruction,
    ] =
      await Promise.all([
        this.fetchCompany(companyId),
        this.fetchWorkspaceName(),
        this.fetchMembers(companyId),
        this.fetchAssets(companyId, bindings),
        this.fetchArticles(companyId, bindings),
        this.fetchPasswords(companyId, opts.includePasswords),
        this.fetchDomains(companyId),
        this.fetchUploads(companyId),
        this.fetchIpam(companyId, bindings),
        this.fetchRelations(companyId, bindings),
        this.fetchReconstruction(companyId, bindings),
      ]);

    if (!company) throw new Error(`Company ${companyId} not found`);

    return {
      workspaceName,
      company,
      members: memberships,
      assets,
      passwords,
      articles,
      domains,
      uploads,
      ipam,
      relations,
      reconstruction,
      exportedAt: new Date(),
      includePasswords: opts.includePasswords,
    };
  }

  // -------------------------------------------------------------------------
  // Private fetchers
  // -------------------------------------------------------------------------

  private async fetchSafeSyncBindings(companyId: string): Promise<SafeSyncBindingIndex> {
    const rows = await this.prisma.integrationSyncRecord.findMany({
      where: { companyId },
      select: {
        ...reconstructionTargetSelect,
        id: true,
        state: true,
        staleSince: true,
        provenance: true,
        companyMapping: {
          select: {
            companyId: true,
            integration: { select: { id: true, name: true, driver: true } },
          },
        },
        resource: { select: { integrationId: true, resourceKey: true } },
      },
      orderBy: [{ targetKind: 'asc' }, { id: 'asc' }],
      take: COMPANY_EXPORT_LIMITS.provenance + 1,
    });
    assertWithinExportLimit(rows, COMPANY_EXPORT_LIMITS.provenance, 'Source provenance');

    const all = rows.flatMap((row): SafeSyncBinding[] => {
      const parsed = integrationProvenanceSchema.safeParse(row.provenance);
      const integration = row.companyMapping.integration;
      const targetId = syncTargetId(row);
      const target = safeExportTarget(companyId, row, {
        integrationCompanyMappingId: row.integrationCompanyMappingId,
        resourceId: row.resourceId,
      });
      if (
        !parsed.success ||
        !targetId ||
        !target ||
        row.companyId !== companyId ||
        row.companyMapping.companyId !== companyId ||
        row.resource.integrationId !== integration.id ||
        parsed.data.integrationId !== integration.id ||
        parsed.data.resourceKey !== row.resource.resourceKey ||
        parsed.data.state !== row.state
      ) return [];
      return [{
        targetKind: row.targetKind,
        targetId,
        integrationCompanyMappingId: row.integrationCompanyMappingId,
        resourceId: row.resourceId,
        state: row.state,
        staleSince: row.staleSince,
        driver: integration.driver,
        sourceLabel: boundedText(integration.name, 256, 'Integration'),
        resourceKey: boundedText(row.resource.resourceKey, 256, 'resource'),
        ownership: parsed.data.ownership,
        firstSeenAt: new Date(parsed.data.firstSeenAt),
        lastSeenAt: new Date(parsed.data.lastSeenAt),
        lastSyncedAt: parsed.data.lastSyncedAt ? new Date(parsed.data.lastSyncedAt) : null,
        target,
      }];
    });
    all.sort(compareSafeBindings);
    const byTarget = new Map<string, SafeSyncBinding[]>();
    for (const binding of all) {
      const key = bindingKey(binding.targetKind, binding.targetId);
      byTarget.set(key, [...(byTarget.get(key) ?? []), binding]);
    }
    return { all, byTarget };
  }

  private async fetchWorkspaceName(): Promise<string> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { id: 'singleton' },
      select: { workspaceName: true },
    });
    const name = row?.workspaceName?.trim();
    return name && name.length > 0 ? name : 'My Company';
  }

  private async fetchCompany(companyId: string): Promise<ExportCompany | null> {
    const row = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        slug: true,
        type: true,
        quickNotes: true,
        contactName: true,
        contactTitle: true,
        contactEmail: true,
        contactPhone: true,
        generalEmail: true,
        phone: true,
        fax: true,
        website: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        region: true,
        postalCode: true,
        country: true,
        createdAt: true,
        parent: { select: { name: true } },
      },
    });
    if (!row) return null;
    return { ...row, parentName: row.parent?.name ?? null };
  }

  private async fetchMembers(companyId: string): Promise<ExportMember[]> {
    const rows = await this.prisma.membership.findMany({
      where: { companyId, revokedAt: null },
      select: {
        role: true,
        expiresAt: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      name: m.user.name,
      email: m.user.email,
      role: m.role,
      expiresAt: m.expiresAt,
    }));
  }

  private async fetchAssets(
    companyId: string,
    bindings: SafeSyncBindingIndex,
  ): Promise<ExportAsset[]> {
    const staleIds = staleBoundIds(bindings, 'asset');
    const rows = await this.prisma.asset.findMany({
      where: {
        companyId,
        OR: [
          { archivedAt: null },
          ...(staleIds.length > 0 ? [{ id: { in: staleIds }, archivedAt: { not: null } }] : []),
        ],
      },
      include: {
        assetLayout: { select: { name: true } },
        fieldValues: {
          include: {
            assetField: { select: { name: true, slug: true, fieldType: true, position: true } },
          },
        },
      },
      orderBy: [{ assetLayout: { name: 'asc' } }, { name: 'asc' }],
    });

    const exportRows = rows.filter((row) => !row.archivedAt || staleIds.includes(row.id));
    const assetReferenceIds = new Set<string>();
    const tagIds = new Set<string>();
    for (const asset of exportRows) {
      for (const fv of asset.fieldValues) {
        if (fv.assetField.fieldType === 'ASSET_REFERENCE') {
          for (const id of listStrings(fv.value)) {
            if (UUID_RE.test(id)) assetReferenceIds.add(id);
          }
        } else if (fv.assetField.fieldType === 'TAGS') {
          // Pre-migration TAGS rows can hold raw names like "production"
          // alongside UUIDs (see TagsService spec). Filter to UUIDs so the
          // Prisma UUID column doesn't reject the query, and let the
          // formatter fall through to the raw string for the rest.
          for (const id of listStrings(fv.value)) {
            if (UUID_RE.test(id)) tagIds.add(id);
          }
        }
      }
    }

    const [assetReferenceRows, tagRows] = await Promise.all([
      assetReferenceIds.size > 0
        ? this.prisma.asset.findMany({
            where: { companyId, id: { in: Array.from(assetReferenceIds) } },
            select: { id: true, name: true },
          })
        : Promise.resolve(
            [] as Array<{ id: string; name: string }>,
          ),
      tagIds.size > 0
        ? this.prisma.tag.findMany({
            where: { id: { in: Array.from(tagIds) } },
            select: { id: true, name: true },
          })
        : Promise.resolve([] as Array<{ id: string; name: string }>),
    ]);
    const labelLookup = new Map<string, string>();
    for (const r of assetReferenceRows) labelLookup.set(r.id, r.name);
    for (const r of tagRows) labelLookup.set(r.id, r.name);

    return exportRows.map((a) => {
      const targetBindings = bindings.byTarget.get(bindingKey('asset', a.id)) ?? [];
      const binding = preferredBreezeBinding(targetBindings);
      const staleState = staleExportState(targetBindings);
      return {
      name: a.name,
      layoutName: a.assetLayout.name,
      fields: a.fieldValues
        .slice()
        .sort((left, right) => left.assetField.position - right.assetField.position)
        .flatMap((fv): ExportAssetField[] => {
          const fieldType = fv.assetField.fieldType;
          const safeValue = binding
            ? safeSynchronizedAssetField(fv.assetField.slug, fv.assetField.name, fv.value)
            : { include: true, value: fv.value };
          if (!safeValue.include) return [];
          const needsLabels = fieldType === 'ASSET_REFERENCE' || fieldType === 'TAGS';
          const synchronizedLabels = binding && needsLabels
            ? listStrings(fv.value)
                .flatMap((id) => labelLookup.get(id) ?? (!UUID_RE.test(id) ? id : []))
            : null;
          if (synchronizedLabels && synchronizedLabels.length === 0) return [];
          return [{
            label: fv.assetField.name,
            fieldType,
            value: synchronizedLabels ?? safeValue.value,
            ...(needsLabels && !binding
              ? {
                  referenceLabels: Object.fromEntries(
                    listStrings(fv.value)
                      .map((id) => [id, labelLookup.get(id)])
                      .filter((entry): entry is [string, string] => Boolean(entry[1])),
                  ),
                }
              : {}),
          }];
        }),
      ...(staleState ? { reconstructionState: staleState } : {}),
    };
    });
  }

  private async fetchArticles(
    companyId: string,
    bindings: SafeSyncBindingIndex,
  ): Promise<ExportArticle[]> {
    const staleIds = staleBoundIds(bindings, 'article');
    const rows = await this.prisma.article.findMany({
      where: {
        companyId,
        OR: [
          { archivedAt: null },
          ...(staleIds.length > 0 ? [{ id: { in: staleIds }, archivedAt: { not: null } }] : []),
        ],
      },
      select: {
        id: true,
        title: true,
        editorMode: true,
        content: true,
        markdownSource: true,
        contentPlaintext: true,
        updatedAt: true,
        archivedAt: true,
        folder: { select: { name: true } },
      },
      orderBy: [{ folder: { name: 'asc' } }, { title: 'asc' }],
    });
    const exportRows = rows.filter((row) => !row.archivedAt || staleIds.includes(row.id));
    const imageIds = new Set<string>();
    const imageIdsByArticle = new Map<string, string[]>();
    for (const article of exportRows) {
      const body =
        article.editorMode === 'markdown' ? article.markdownSource : article.content;
      const ids = Array.from(extractEmbeddedUploadIds(body));
      imageIdsByArticle.set(article.id, ids);
      for (const id of ids) imageIds.add(id);
    }

    const uploads =
      imageIds.size > 0
        ? await this.prisma.upload.findMany({
            where: {
              companyId,
              deletedAt: null,
              id: { in: Array.from(imageIds) },
            },
            select: {
              id: true,
              filename: true,
              mimeType: true,
              storageKey: true,
              width: true,
              height: true,
            },
          })
        : [];
    const uploadsById = new Map(uploads.map((u) => [u.id.toLowerCase(), u]));

    return exportRows.map((a) => {
      const targetBindings = bindings.byTarget.get(bindingKey('article', a.id)) ?? [];
      const binding = preferredBreezeBinding(targetBindings);
      const staleState = staleExportState(targetBindings);
      const safeArticle = binding
        ? safeSynchronizedArticle(a.markdownSource, a.contentPlaintext, binding)
        : null;
      return {
      id: a.id,
      title: a.title,
      folderPath: a.folder?.name ?? '/',
      editorMode: safeArticle ? 'markdown' : a.editorMode as 'tiptap' | 'markdown',
      content: safeArticle ? null : a.content,
      markdownSource: safeArticle?.markdownSource ?? a.markdownSource,
      contentPlaintext: safeArticle?.contentPlaintext ?? a.contentPlaintext,
      images: (imageIdsByArticle.get(a.id) ?? [])
        .map((id) => uploadsById.get(id))
        .filter((u): u is (typeof uploads)[number] => u !== undefined)
        .map((u) => ({
          uploadId: u.id,
          filename: u.filename,
          mimeType: u.mimeType,
          storageKey: u.storageKey,
          width: u.width,
          height: u.height,
        })),
      updatedAt: a.updatedAt,
      ...(staleState ? { reconstructionState: staleState } : {}),
    };
    });
  }

  private async fetchPasswords(
    companyId: string,
    decrypt: boolean,
  ): Promise<ExportPassword[]> {
    // Only pull cipher columns from Postgres when the caller actually
    // intends to decrypt them. The metadata-only path keeps sensitive
    // bytes out of the worker process entirely (and out of any Prisma
    // query log) — important when this exact service runs in the worker
    // image, which has fewer log scrubbers than the API.
    const baseSelect = {
      name: true,
      username: true,
      url: true,
      tags: true,
      lastRotatedAt: true,
      expiresAt: true,
      pwnedCount: true,
      folder: { select: { name: true } },
    } as const;

    if (!decrypt) {
      const rows = await this.prisma.password.findMany({
        where: { companyId, archivedAt: null },
        select: baseSelect,
        orderBy: [{ folder: { name: 'asc' } }, { name: 'asc' }],
      });
      return rows.map((p) => ({
        name: p.name,
        username: p.username,
        url: p.url,
        folderPath: p.folder?.name ?? '/',
        tags: p.tags,
        password: null,
        notes: null,
        totpSecret: null,
        lastRotatedAt: p.lastRotatedAt,
        expiresAt: p.expiresAt,
        pwnedCount: p.pwnedCount,
      }));
    }

    const rows = await this.prisma.password.findMany({
      where: { companyId, archivedAt: null },
      select: {
        ...baseSelect,
        // Row id is needed to rebuild each blob's AAD identity — it is
        // consumed for decryption only and never lands in the export.
        id: true,
        passwordCiphertext: true,
        notesCiphertext: true,
        totpSecretCiphertext: true,
      },
      orderBy: [{ folder: { name: 'asc' } }, { name: 'asc' }],
    });

    return rows.map((p) => {
      let password: string | null;
      try {
        password = this.crypto.decrypt(
          p.passwordCiphertext,
          passwordVaultAad(companyId, p.id, 'password'),
        );
      } catch {
        password = '[decryption error]';
      }

      let notes: unknown | null = null;
      if (p.notesCiphertext) {
        try {
          notes = parseJsonIfPossible(
            this.crypto.decrypt(
              p.notesCiphertext,
              passwordVaultAad(companyId, p.id, 'notes'),
            ),
          );
        } catch {
          notes = '[decryption error]';
        }
      }

      let totpSecret: string | null = null;
      if (p.totpSecretCiphertext) {
        try {
          totpSecret = this.crypto.decrypt(
            p.totpSecretCiphertext,
            passwordVaultAad(companyId, p.id, 'totp'),
          );
        } catch {
          totpSecret = '[decryption error]';
        }
      }

      return {
        name: p.name,
        username: p.username,
        url: p.url,
        folderPath: p.folder?.name ?? '/',
        tags: p.tags,
        password,
        notes,
        totpSecret,
        lastRotatedAt: p.lastRotatedAt,
        expiresAt: p.expiresAt,
        pwnedCount: p.pwnedCount,
      };
    });
  }

  private async fetchDomains(companyId: string): Promise<ExportDomain[]> {
    const rows = await this.prisma.monitoredDomain.findMany({
      where: { companyId, archivedAt: null },
      select: {
        hostname: true,
        latestStatus: true,
        whoisExpiresAt: true,
        tlsExpiresAt: true,
        lastCheckedAt: true,
      },
      orderBy: { hostname: 'asc' },
    });
    return rows.map((d) => ({
      hostname: d.hostname,
      latestStatus: d.latestStatus,
      whoisExpiresAt: d.whoisExpiresAt,
      tlsExpiresAt: d.tlsExpiresAt,
      lastCheckedAt: d.lastCheckedAt,
    }));
  }

  private async fetchUploads(companyId: string): Promise<ExportUpload[]> {
    const rows = await this.prisma.upload.findMany({
      where: { companyId, deletedAt: null },
      select: {
        filename: true,
        mimeType: true,
        sizeBytes: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((u) => ({
      filename: u.filename,
      mimeType: u.mimeType,
      sizeBytes: u.sizeBytes,
      createdAt: u.createdAt,
    }));
  }

  private async fetchIpam(
    companyId: string,
    bindings: SafeSyncBindingIndex,
  ): Promise<ExportSubnet[]> {
    const staleSubnetIds = staleBoundIds(bindings, 'subnet');
    const subnets = await this.prisma.subnet.findMany({
      where: {
        companyId,
        OR: [
          { archivedAt: null },
          ...(staleSubnetIds.length > 0
            ? [{ id: { in: staleSubnetIds }, archivedAt: { not: null } }]
            : []),
        ],
      },
      select: {
        id: true,
        companyId: true,
        name: true,
        cidr: true,
        prefix: true,
        vlanId: true,
        gateway: true,
        dhcpRangeStart: true,
        dhcpRangeEnd: true,
        description: true,
        archivedAt: true,
      },
      orderBy: [{ name: 'asc' }, { cidr: 'asc' }, { id: 'asc' }],
      take: COMPANY_EXPORT_LIMITS.subnets + 1,
    });
    assertWithinExportLimit(subnets, COMPANY_EXPORT_LIMITS.subnets, 'Subnets');
    const exportSubnets = subnets.filter(
      (subnet) => !subnet.archivedAt || staleSubnetIds.includes(subnet.id),
    );
    if (exportSubnets.length === 0) return [];

    const subnetIds = exportSubnets.map((subnet) => subnet.id);
    const subnetIdSet = new Set(subnetIds);
    const [reservations, occupantRows] = await Promise.all([
      this.prisma.ipReservation.findMany({
        where: { companyId, subnetId: { in: subnetIds } },
        select: {
          id: true,
          companyId: true,
          subnetId: true,
          ipAddress: true,
          label: true,
          notes: true,
          subnet: { select: { companyId: true } },
        },
        orderBy: [{ ipAddress: 'asc' }, { label: 'asc' }, { id: 'asc' }],
        take: COMPANY_EXPORT_LIMITS.reservations + 1,
      }),
      this.prisma.assetFieldValue.findMany({
        where: {
          companyId,
          asset: { companyId },
          assetField: { slug: { in: ['interfaces', 'network-addresses'] } },
        },
        select: {
          id: true,
          companyId: true,
          assetId: true,
          value: true,
          asset: { select: { id: true, companyId: true, name: true } },
          assetField: { select: { name: true, slug: true, fieldType: true } },
        },
        orderBy: [{ assetId: 'asc' }, { id: 'asc' }],
        take: COMPANY_EXPORT_LIMITS.occupants + 1,
      }),
    ]);
    assertWithinExportLimit(
      reservations,
      COMPANY_EXPORT_LIMITS.reservations,
      'IP reservations',
    );
    assertWithinExportLimit(
      occupantRows,
      COMPANY_EXPORT_LIMITS.occupants,
      'IPAM occupants',
    );

    const reservationsBySubnet = new Map<string, ExportIpReservation[]>();
    for (const reservation of reservations) {
      if (
        reservation.companyId !== companyId ||
        reservation.subnet.companyId !== companyId ||
        !subnetIdSet.has(reservation.subnetId)
      ) {
        throw new Error('Inconsistent IPAM export scope.');
      }
      const list = reservationsBySubnet.get(reservation.subnetId) ?? [];
      list.push({
        ipAddress: reservation.ipAddress,
        label: boundedText(reservation.label, 200, 'Reserved address'),
        notes: boundedNullableText(reservation.notes, 2_000),
      });
      reservationsBySubnet.set(reservation.subnetId, list);
    }

    const reservationSubnetIdsByIp = new Map<string, Set<string>>();
    for (const reservation of reservations) {
      const ip = normalizeIpv4V4(reservation.ipAddress);
      if (!ip) continue;
      const subnetIdsForIp = reservationSubnetIdsByIp.get(ip) ?? new Set<string>();
      subnetIdsForIp.add(reservation.subnetId);
      reservationSubnetIdsByIp.set(ip, subnetIdsForIp);
    }
    const subnetsById = new Map(exportSubnets.map((subnet) => [subnet.id, subnet]));
    const projectionsByAsset = new Map<string, {
      assetId: string;
      assetLabel: string;
      interfaces: string[];
      addresses: Array<Record<string, string>>;
    }>();
    for (const row of occupantRows) {
      if (
        row.companyId !== companyId ||
        row.asset.companyId !== companyId ||
        row.asset.id !== row.assetId ||
        typeof row.value !== 'string' ||
        !preferredBreezeBinding(bindings.byTarget.get(bindingKey('asset', row.assetId)) ?? [])
      ) continue;
      const current = projectionsByAsset.get(row.assetId) ?? {
        assetId: row.assetId,
        assetLabel: boundedText(row.asset.name, 200, 'Asset'),
        interfaces: [],
        addresses: [],
      };
      if (row.assetField.slug === 'interfaces') {
        current.interfaces.push(...parseBreezeProjection(row.value)
          .map((item) => item['Name']?.trim() ?? '')
          .filter(Boolean));
      } else if (row.assetField.slug === 'network-addresses') {
        current.addresses.push(...parseBreezeProjection(row.value));
      }
      projectionsByAsset.set(row.assetId, current);
    }

    type ScopedOccupant = ExportSubnetOccupant & { subnetId: string };
    const safeOccupants = [...projectionsByAsset.values()].flatMap((projection) => {
      const interfaceNames = new Set(projection.interfaces);
      return projection.addresses.flatMap((address): ScopedOccupant[] => {
        const interfaceLabel = address['Interface']?.trim();
        const rawAddress = address['Address']?.split('/', 1)[0]?.trim();
        const ip = rawAddress ? normalizeIpv4V4(rawAddress) : null;
        const assignment = address['Assignment']?.trim().toLowerCase() ?? '';
        const eligible = /^(?:yes|true|1)$/i.test(address['Reservation eligible']?.trim() ?? '');
        const active = !/^(?:no|false|0)$/i.test(address['Active']?.trim() ?? '');
        if (
          !ip ||
          !interfaceLabel ||
          !interfaceNames.has(interfaceLabel) ||
          !active ||
          (!eligible && !['static', 'manual', 'reserved'].includes(assignment))
        ) return [];
        const reservationSubnetIds = reservationSubnetIdsByIp.get(ip);
        if (!reservationSubnetIds || reservationSubnetIds.size === 0) return [];
        const addressPrefix = ipv4MaskPrefix(address['Subnet mask']);
        const matchingSubnetIds = [...reservationSubnetIds].filter((subnetId) => {
          const subnet = subnetsById.get(subnetId);
          return Boolean(
            subnet &&
            ipInCidr(ip, subnet.cidr) &&
            (addressPrefix === null || subnet.prefix === addressPrefix),
          );
        });
        // A single exact native reservation/subnet is proof. Multiple or
        // mask-inconsistent candidates are ambiguous and must be omitted.
        if (matchingSubnetIds.length !== 1) return [];
        return [{
          subnetId: matchingSubnetIds[0]!,
          ipAddress: ip,
          assetLabel: projection.assetLabel,
          interfaceLabel: boundedText(interfaceLabel, 200, 'Interface'),
          assetHref: `/admin/companies/${companyId}/assets/${projection.assetId}`,
        }];
      });
    });

    if (
      exportSubnets.length * safeOccupants.length >
      COMPANY_EXPORT_LIMITS.ipamMembershipChecks
    ) {
      throw new Error('IPAM occupant matching exceeded the bounded export limit.');
    }

    return exportSubnets
      .map((subnet) => {
        if (subnet.companyId !== companyId) {
          throw new Error('Inconsistent IPAM export scope.');
        }
        const staleState = staleExportState(
          bindings.byTarget.get(bindingKey('subnet', subnet.id)) ?? [],
        );
        return {
          name: boundedText(subnet.name, 200, 'Subnet'),
          cidr: subnet.cidr,
          prefix: subnet.prefix,
          vlanId: subnet.vlanId,
          gateway: subnet.gateway,
          dhcpRangeStart: subnet.dhcpRangeStart,
          dhcpRangeEnd: subnet.dhcpRangeEnd,
          description: boundedNullableText(subnet.description, 2_000),
          reservations: (reservationsBySubnet.get(subnet.id) ?? [])
            .sort((left, right) => compareIpv4(left.ipAddress, right.ipAddress) ||
              left.label.localeCompare(right.label)),
          occupants: safeOccupants
            .filter((occupant) => occupant.subnetId === subnet.id)
            .map(({ subnetId: _subnetId, ...occupant }) => occupant)
            .sort((left, right) => compareIpv4(left.ipAddress, right.ipAddress) ||
              left.assetLabel.localeCompare(right.assetLabel) ||
              left.interfaceLabel.localeCompare(right.interfaceLabel)),
          ...(staleState ? { reconstructionState: staleState } : {}),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.cidr.localeCompare(right.cidr));
  }

  private async fetchRelations(
    companyId: string,
    bindings: SafeSyncBindingIndex,
  ): Promise<ExportRelation[]> {
    const rows = await this.prisma.relation.findMany({
      where: { companyId },
      select: {
        id: true,
        companyId: true,
        sourceType: true,
        sourceId: true,
        targetType: true,
        targetId: true,
        relationType: true,
        createdAt: true,
      },
      orderBy: [
        { relationType: 'asc' },
        { sourceType: 'asc' },
        { sourceId: 'asc' },
        { targetType: 'asc' },
        { targetId: 'asc' },
        { id: 'asc' },
      ],
      take: COMPANY_EXPORT_LIMITS.relations + 1,
    });
    assertWithinExportLimit(rows, COMPANY_EXPORT_LIMITS.relations, 'Relations');
    if (rows.length === 0) return [];
    if (rows.some((row) => row.companyId !== companyId)) {
      throw new Error('Inconsistent relation export scope.');
    }

    const idsByType = relationEndpointIds(rows);
    const staleAssetIds = new Set(staleBoundIds(bindings, 'asset'));
    const staleArticleIds = new Set(staleBoundIds(bindings, 'article'));
    const [assets, articles, passwords] = await Promise.all([
      idsByType.asset.length > 0
        ? this.prisma.asset.findMany({
            where: {
              companyId,
              id: { in: idsByType.asset },
              OR: [
                { archivedAt: null },
                ...(staleAssetIds.size > 0
                  ? [{ id: { in: [...staleAssetIds] }, archivedAt: { not: null } }]
                  : []),
              ],
            },
            select: { id: true, companyId: true, name: true },
          })
        : [],
      idsByType.article.length > 0
        ? this.prisma.article.findMany({
            where: {
              companyId,
              id: { in: idsByType.article },
              OR: [
                { archivedAt: null },
                ...(staleArticleIds.size > 0
                  ? [{ id: { in: [...staleArticleIds] }, archivedAt: { not: null } }]
                  : []),
              ],
            },
            select: { id: true, companyId: true, title: true },
          })
        : [],
      idsByType.password.length > 0
        ? this.prisma.password.findMany({
            where: { companyId, id: { in: idsByType.password }, archivedAt: null },
            select: { id: true, companyId: true, name: true },
          })
        : [],
    ]);
    const endpoints = new Map<string, ExportRelationEndpoint>();
    for (const asset of assets) {
      if (asset.companyId !== companyId) continue;
      endpoints.set(`Asset:${asset.id}`, {
        kind: 'asset', label: boundedText(asset.name, 256, 'Asset'),
        href: `/admin/companies/${companyId}/assets/${asset.id}`,
      });
    }
    for (const article of articles) {
      if (article.companyId !== companyId) continue;
      endpoints.set(`Article:${article.id}`, {
        kind: 'article', label: boundedText(article.title, 256, 'Article'),
        href: `/admin/companies/${companyId}/articles/${article.id}`,
      });
    }
    for (const password of passwords) {
      if (password.companyId !== companyId) continue;
      endpoints.set(`Password:${password.id}`, {
        kind: 'password', label: boundedText(password.name, 256, 'Password'),
        href: `/admin/companies/${companyId}/passwords/${password.id}`,
      });
    }

    return rows
      .flatMap((row) => {
        const source = endpoints.get(`${row.sourceType}:${row.sourceId}`);
        const target = endpoints.get(`${row.targetType}:${row.targetId}`);
        // Unknown, archived, or foreign-company polymorphic endpoints are
        // deliberately omitted rather than exposing their ids as labels.
        if (!source || !target) return [];
        const staleStates = [
          staleExportState(bindings.byTarget.get(bindingKey('relation', row.id)) ?? []),
          staleExportState(bindings.byTarget.get(
            bindingKey(endpointKind(row.sourceType), row.sourceId),
          ) ?? []),
          staleExportState(bindings.byTarget.get(
            bindingKey(endpointKind(row.targetType), row.targetId),
          ) ?? []),
        ].filter((state): state is ExportReconstructionState => state !== null)
          .sort((left, right) => left.staleSince.getTime() - right.staleSince.getTime() ||
            left.sourceLabel.localeCompare(right.sourceLabel));
        const state = staleStates[0];
        return [{
              relationType: boundedText(row.relationType, 128, 'related_to'),
              source,
              target,
              createdAt: row.createdAt,
              ...(state ? { reconstructionState: state } : {}),
            }];
      })
      .sort((left, right) => left.relationType.localeCompare(right.relationType) ||
        left.source.label.localeCompare(right.source.label) ||
        left.target.label.localeCompare(right.target.label));
  }

  private async fetchReconstruction(
    companyId: string,
    bindings: SafeSyncBindingIndex,
  ): Promise<CompanyExportData['reconstruction']> {
    const [summaryRows, gapRows] = await Promise.all([
      this.prisma.integrationReconstructionSummary.findMany({
        // Cleared (non-participant) tombstones keep the evaluation clock
        // alive but are not scorecards.
        where: { companyId, resourceId: { not: null }, clearedAt: null },
        include: {
          companyMapping: { select: { companyId: true, integrationId: true } },
          resource: { select: { integrationId: true, resourceKey: true } },
        },
        orderBy: [{ resourceId: 'asc' }, { id: 'asc' }],
        take: COMPANY_EXPORT_LIMITS.reconstructionSummaries + 1,
      }),
      this.prisma.integrationReconstructionGap.findMany({
        where: { companyId, resolvedAt: null },
        include: {
          companyMapping: { select: { companyId: true, integrationId: true } },
          resource: { select: { integrationId: true, resourceKey: true } },
          syncRecord: { select: reconstructionTargetSelect },
        },
        orderBy: [{ kind: 'asc' }, { resourceId: 'asc' }, { firstSeenAt: 'asc' }, { id: 'asc' }],
        take: COMPANY_EXPORT_LIMITS.reconstructionGaps + 1,
      }),
    ]);
    assertWithinExportLimit(
      summaryRows,
      COMPANY_EXPORT_LIMITS.reconstructionSummaries,
      'Reconstruction summaries',
    );
    assertWithinExportLimit(
      gapRows,
      COMPANY_EXPORT_LIMITS.reconstructionGaps,
      'Reconstruction gaps',
    );

    const summaries = summaryRows.map((row) => {
      assertReconstructionExportScope(companyId, row.companyMapping, row.resource);
      return {
        resourceKey: boundedText(row.resource!.resourceKey, 256, 'resource'),
        resourceLabel: readableResourceLabel(
          boundedText(row.resource!.resourceKey, 256, 'resource'),
        ),
        counts: reconstructionCompletenessCountsSchema.parse(row.counts),
        evaluatedAt: row.evaluatedAt,
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
      };
    }).sort((left, right) => left.resourceLabel.localeCompare(right.resourceLabel) ||
      left.resourceKey.localeCompare(right.resourceKey));

    const gaps = gapRows.map((row) => {
      assertReconstructionExportScope(companyId, row.companyMapping, row.resource);
      return {
        resourceKey: boundedText(row.resource.resourceKey, 256, 'resource'),
        resourceLabel: readableResourceLabel(
          boundedText(row.resource.resourceKey, 256, 'resource'),
        ),
        kind: row.kind,
        message: safeExportGapMessage(row.kind, row.message),
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        resolvedAt: row.resolvedAt,
        target: safeExportTarget(companyId, row.syncRecord, {
          integrationCompanyMappingId: row.integrationCompanyMappingId,
          resourceId: row.resourceId,
        }),
      };
    }).sort((left, right) => left.kind.localeCompare(right.kind) ||
      left.resourceLabel.localeCompare(right.resourceLabel) ||
      left.message.localeCompare(right.message));

    const provenance = bindings.all.map((row) => ({
      sourceLabel: row.sourceLabel,
      sourceResource: row.resourceKey,
      ownership: row.ownership,
      state: row.state,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      lastSyncedAt: row.lastSyncedAt,
      staleSince: row.staleSince,
      target: row.target,
    })).sort((left, right) => left.target.label.localeCompare(right.target.label) ||
      left.sourceResource.localeCompare(right.sourceResource) || left.state.localeCompare(right.state));

    return { summaries, gaps, provenance };
  }
}

const reconstructionTargetSelect = {
  companyId: true,
  integrationCompanyMappingId: true,
  resourceId: true,
  targetKind: true,
  assetId: true,
  subnetId: true,
  ipReservationId: true,
  articleId: true,
  relationId: true,
  asset: { select: { name: true, companyId: true } },
  subnet: { select: { name: true, companyId: true } },
  ipReservation: {
    select: {
      label: true,
      subnetId: true,
      companyId: true,
      subnet: { select: { companyId: true } },
    },
  },
  article: { select: { title: true, companyId: true } },
  relation: { select: { companyId: true } },
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function listStrings(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value != null ? [value] : [];
  return list.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function assertWithinExportLimit<T>(rows: readonly T[], limit: number, label: string): void {
  if (rows.length > limit) {
    throw new Error(`${label} exceeded the bounded export limit of ${limit}.`);
  }
}

function compareIpv4(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 4; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function ipv4MaskPrefix(value: string | undefined): number | null {
  if (!value || value === '—') return null;
  const slashMatch = /^\/?(\d{1,2})$/.exec(value.trim());
  if (slashMatch) {
    const prefix = Number(slashMatch[1]);
    return prefix >= 0 && prefix <= 32 ? prefix : null;
  }
  const octets = value.trim().split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) return null;
  const bits = octets.map((octet) => octet.toString(2).padStart(8, '0')).join('');
  if (!/^1*0*$/.test(bits)) return null;
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

function relationEndpointIds(rows: Array<{
  sourceType: string;
  sourceId: string;
  targetType: string;
  targetId: string;
}>): Record<ExportRelationEndpoint['kind'], string[]> {
  const ids = {
    asset: new Set<string>(),
    article: new Set<string>(),
    password: new Set<string>(),
  };
  for (const row of rows) {
    addRelationEndpointId(ids, row.sourceType, row.sourceId);
    addRelationEndpointId(ids, row.targetType, row.targetId);
  }
  return {
    asset: [...ids.asset].sort(),
    article: [...ids.article].sort(),
    password: [...ids.password].sort(),
  };
}

function addRelationEndpointId(
  ids: Record<ExportRelationEndpoint['kind'], Set<string>>,
  type: string,
  id: string,
): void {
  const kind = { Asset: 'asset', Article: 'article', Password: 'password' }[type] as
    | ExportRelationEndpoint['kind']
    | undefined;
  if (kind) ids[kind].add(id);
}

function assertReconstructionExportScope(
  companyId: string,
  mapping: { companyId: string; integrationId: string },
  resource: { integrationId: string } | null,
): asserts resource is { integrationId: string } {
  if (
    !resource ||
    mapping.companyId !== companyId ||
    mapping.integrationId !== resource.integrationId
  ) {
    throw new Error('Inconsistent reconstruction export scope.');
  }
}

function readableResourceLabel(resourceKey: string): string {
  return resourceKey
    .split('-')
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

function safeExportGapMessage(kind: string, message: string): string {
  return message.length <= 512 && scanSensitiveMaterial(message) === 'safe'
    ? message
    : `A ${kind.replaceAll('_', ' ')} item requires operator review.`;
}

function safeExportTarget(
  companyId: string,
  record: {
    companyId: string;
    integrationCompanyMappingId: string;
    resourceId: string;
    targetKind: string;
    assetId: string | null;
    subnetId: string | null;
    ipReservationId: string | null;
    articleId: string | null;
    relationId: string | null;
    asset: { name: string; companyId: string } | null;
    subnet: { name: string; companyId: string } | null;
    ipReservation: {
      label: string;
      subnetId: string;
      companyId: string;
      subnet: { companyId: string };
    } | null;
    article: { title: string; companyId: string } | null;
    relation: { companyId: string } | null;
  } | null,
  expectedScope?: {
    integrationCompanyMappingId: string;
    resourceId: string;
  },
): ExportNativeTarget | null {
  if (
    !record ||
    record.companyId !== companyId ||
    (expectedScope && (
      record.integrationCompanyMappingId !== expectedScope.integrationCompanyMappingId ||
      record.resourceId !== expectedScope.resourceId
    ))
  ) return null;
  switch (record.targetKind) {
    case 'asset':
      return record.assetId && record.asset?.companyId === companyId
        ? {
            kind: 'asset',
            label: boundedText(record.asset.name, 256, 'Asset'),
            href: `/admin/companies/${companyId}/assets/${record.assetId}`,
          }
        : null;
    case 'subnet':
      return record.subnetId && record.subnet?.companyId === companyId
        ? {
            kind: 'subnet',
            label: boundedText(record.subnet.name, 256, 'Subnet'),
            href: `/admin/companies/${companyId}/ipam/${record.subnetId}`,
          }
        : null;
    case 'ip_reservation':
      return record.ipReservationId &&
        record.ipReservation?.companyId === companyId &&
        record.ipReservation.subnet.companyId === companyId
        ? {
            kind: 'ip_reservation',
            label: boundedText(record.ipReservation.label, 256, 'Reserved address'),
            href: `/admin/companies/${companyId}/ipam/${record.ipReservation.subnetId}`,
          }
        : null;
    case 'article':
      return record.articleId && record.article?.companyId === companyId
        ? {
            kind: 'article',
            label: boundedText(record.article.title, 256, 'Article'),
            href: `/admin/companies/${companyId}/articles/${record.articleId}`,
          }
        : null;
    case 'relation':
      return record.relationId && record.relation?.companyId === companyId
        ? { kind: 'relation', label: 'Relationship', href: null }
        : null;
    default:
      return null;
  }
}

function syncTargetId(record: {
  targetKind: string;
  assetId: string | null;
  subnetId: string | null;
  ipReservationId: string | null;
  articleId: string | null;
  relationId: string | null;
}): string | null {
  switch (record.targetKind) {
    case 'asset': return record.assetId;
    case 'subnet': return record.subnetId;
    case 'ip_reservation': return record.ipReservationId;
    case 'article': return record.articleId;
    case 'relation': return record.relationId;
    default: return null;
  }
}

function bindingKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function staleBoundIds(
  bindings: SafeSyncBindingIndex,
  kind: IntegrationTargetKind,
): string[] {
  return [...bindings.byTarget.entries()]
    .filter(([key, targetBindings]) =>
      key.startsWith(`${kind}:`) && staleExportState(targetBindings) !== null)
    .map(([key]) => key.slice(kind.length + 1))
    .sort();
}

function staleExportState(
  bindings: SafeSyncBinding[],
): ExportReconstructionState | null {
  const applicable = breezeOwnedBindings(bindings);
  if (
    applicable.length === 0 ||
    applicable.some((binding) => binding.state !== 'stale' || !binding.staleSince)
  ) return null;
  const ordered = applicable.slice().sort((left, right) =>
    left.staleSince!.getTime() - right.staleSince!.getTime() ||
    left.sourceLabel.localeCompare(right.sourceLabel) ||
    left.resourceKey.localeCompare(right.resourceKey),
  );
  return {
    state: 'stale',
    staleSince: ordered[0]!.staleSince!,
    sourceLabel: [...new Set(applicable.map((binding) => binding.sourceLabel))]
      .sort()
      .join(', '),
  };
}

function preferredBreezeBinding(bindings: SafeSyncBinding[]): SafeSyncBinding | undefined {
  return breezeOwnedBindings(bindings)
    .slice()
    .sort((left, right) =>
      Number(left.state === 'stale') - Number(right.state === 'stale') ||
      (right.lastSyncedAt?.getTime() ?? 0) - (left.lastSyncedAt?.getTime() ?? 0) ||
      left.sourceLabel.localeCompare(right.sourceLabel) ||
      left.resourceKey.localeCompare(right.resourceKey),
    )[0];
}

function breezeOwnedBindings(bindings: SafeSyncBinding[]): SafeSyncBinding[] {
  return bindings.filter((binding) =>
    binding.driver === 'breeze' && binding.ownership === 'breeze'
  );
}

function compareSafeBindings(left: SafeSyncBinding, right: SafeSyncBinding): number {
  return left.targetKind.localeCompare(right.targetKind) ||
    left.targetId.localeCompare(right.targetId) ||
    left.driver.localeCompare(right.driver) ||
    left.ownership.localeCompare(right.ownership) ||
    Number(left.state === 'stale') - Number(right.state === 'stale') ||
    left.sourceLabel.localeCompare(right.sourceLabel) ||
    left.resourceKey.localeCompare(right.resourceKey) ||
    left.firstSeenAt.getTime() - right.firstSeenAt.getTime() ||
    left.lastSeenAt.getTime() - right.lastSeenAt.getTime();
}

function endpointKind(type: string): IntegrationTargetKind {
  if (type === 'Asset') return 'asset';
  if (type === 'Article') return 'article';
  return 'relation';
}

const RAW_SOURCE_FIELD_SLUGS = new Set([
  'breeze-id',
  'upstream-external-id',
  'source-revision',
  'source-fingerprint',
  'site-id',
  'host-device-id',
]);
const RAW_SOURCE_FIELD_NAMES = /^(?:breeze id|upstream external id|source revision|source fingerprint|site id|host device id)$/i;
const UUID_TOKEN_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const STRUCTURED_IDENTIFIER_KEY_RE = /^(?:id|interface id|source id|external id|uuid)$/i;

function safeSynchronizedAssetField(
  slug: string,
  name: string,
  value: unknown,
): { include: boolean; value: unknown } {
  if (RAW_SOURCE_FIELD_SLUGS.has(slug) || RAW_SOURCE_FIELD_NAMES.test(name)) {
    return { include: false, value: null };
  }
  if (typeof value !== 'string') return { include: true, value };
  if (slug === 'interfaces' || slug === 'network-addresses' || value.includes(' | ')) {
    const lines = parseBreezeProjection(value).map((row) =>
      Object.entries(row)
        .filter(([key]) => !STRUCTURED_IDENTIFIER_KEY_RE.test(key))
        .map(([key, cell]) => `${key}: ${stripRawSourceIdentifiers(cell)}`)
        .join(' | '),
    ).filter(Boolean);
    return { include: lines.length > 0, value: lines.join('\n') };
  }
  return { include: true, value: stripRawSourceIdentifiers(value) };
}

function parseBreezeProjection(value: string): Array<Record<string, string>> {
  return value.split(/\r?\n/).flatMap((line) => {
    if (!line.trim() || line.startsWith('[projection truncated:')) return [];
    const row: Record<string, string> = {};
    for (const part of line.split(' | ')) {
      const separator = part.indexOf(':');
      if (separator <= 0) continue;
      row[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
    }
    return Object.keys(row).length > 0 ? [row] : [];
  });
}

function stripRawSourceIdentifiers(value: string): string {
  return value.replace(UUID_TOKEN_RE, '[source identifier omitted]');
}

function safeSynchronizedArticle(
  markdownSource: string | null,
  contentPlaintext: string | null,
  binding: SafeSyncBinding,
): { markdownSource: string; contentPlaintext: string } {
  const source = markdownSource ?? contentPlaintext ?? '';
  const kept: string[] = [];
  let inSourceProvenance = false;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (/<!--\s*weavestream:breeze:managed:(?:start|end)\s*-->/i.test(line)) continue;
    if (/^##\s+Source provenance\s*$/i.test(line)) {
      inSourceProvenance = true;
      continue;
    }
    if (inSourceProvenance) continue;
    if (/^(?:source\s+(?:uuid|id|revision|fingerprint)|policy\s+(?:uuid|id)|target\s+(?:uuid|id)|destination\s+(?:uuid|id)|upstream\s+external\s+id|breeze\s+id)\s*:/i.test(line)) {
      continue;
    }
    kept.push(stripRawSourceIdentifiers(line));
  }
  const lastSynced = binding.lastSyncedAt?.toISOString() ?? 'not recorded';
  const safeMarkdown = `${kept.join('\n').trim()}\n\n## Local synchronization record\nSource: ${binding.sourceLabel}\nLast synchronized: ${lastSynced}`.trim();
  return {
    markdownSource: safeMarkdown,
    contentPlaintext: safeMarkdown.replace(/^#{1,6}\s+/gm, '').trim(),
  };
}

function boundedText(value: string, limit: number, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? [...trimmed].slice(0, limit).join('') : fallback;
}

function boundedNullableText(value: string | null, limit: number): string | null {
  if (value === null) return null;
  return [...value].slice(0, limit).join('');
}
