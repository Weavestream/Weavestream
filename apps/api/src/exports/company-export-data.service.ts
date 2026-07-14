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
        this.fetchAssets(companyId),
        this.fetchArticles(companyId),
        this.fetchPasswords(companyId, opts.includePasswords),
        this.fetchDomains(companyId),
        this.fetchUploads(companyId),
        this.fetchIpam(companyId),
        this.fetchRelations(companyId),
        this.fetchReconstruction(companyId),
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

  private async fetchAssets(companyId: string): Promise<ExportAsset[]> {
    const rows = await this.prisma.asset.findMany({
      where: { companyId, archivedAt: null },
      include: {
        assetLayout: { select: { name: true } },
        fieldValues: {
          include: {
            assetField: { select: { name: true, fieldType: true, position: true } },
          },
        },
      },
      orderBy: [{ assetLayout: { name: 'asc' } }, { name: 'asc' }],
    });

    const assetReferenceIds = new Set<string>();
    const tagIds = new Set<string>();
    for (const asset of rows) {
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

    return rows.map((a) => ({
      name: a.name,
      layoutName: a.assetLayout.name,
      fields: a.fieldValues
        .slice()
        .sort((left, right) => left.assetField.position - right.assetField.position)
        .map((fv) => {
          const fieldType = fv.assetField.fieldType;
          const needsLabels = fieldType === 'ASSET_REFERENCE' || fieldType === 'TAGS';
          return {
            label: fv.assetField.name,
            fieldType,
            value: fv.value,
            ...(needsLabels
              ? {
                  referenceLabels: Object.fromEntries(
                    listStrings(fv.value)
                      .map((id) => [id, labelLookup.get(id)])
                      .filter((entry): entry is [string, string] => Boolean(entry[1])),
                  ),
                }
              : {}),
          };
        }),
    }));
  }

  private async fetchArticles(companyId: string): Promise<ExportArticle[]> {
    const rows = await this.prisma.article.findMany({
      where: { companyId, archivedAt: null },
      select: {
        id: true,
        title: true,
        editorMode: true,
        content: true,
        markdownSource: true,
        contentPlaintext: true,
        updatedAt: true,
        folder: { select: { name: true } },
      },
      orderBy: [{ folder: { name: 'asc' } }, { title: 'asc' }],
    });
    const imageIds = new Set<string>();
    const imageIdsByArticle = new Map<string, string[]>();
    for (const article of rows) {
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

    return rows.map((a) => ({
      id: a.id,
      title: a.title,
      folderPath: a.folder?.name ?? '/',
      editorMode: a.editorMode as 'tiptap' | 'markdown',
      content: a.content,
      markdownSource: a.markdownSource,
      contentPlaintext: a.contentPlaintext,
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
    }));
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

  private async fetchIpam(companyId: string): Promise<ExportSubnet[]> {
    const subnets = await this.prisma.subnet.findMany({
      where: { companyId, archivedAt: null },
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
      },
      orderBy: [{ name: 'asc' }, { cidr: 'asc' }, { id: 'asc' }],
      take: COMPANY_EXPORT_LIMITS.subnets + 1,
    });
    assertWithinExportLimit(subnets, COMPANY_EXPORT_LIMITS.subnets, 'Subnets');
    if (subnets.length === 0) return [];

    const subnetIds = subnets.map((subnet) => subnet.id);
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
          asset: { companyId, archivedAt: null },
          assetField: { fieldType: 'IP_ADDRESS' },
        },
        select: {
          id: true,
          companyId: true,
          assetId: true,
          value: true,
          asset: { select: { id: true, companyId: true, name: true } },
          assetField: { select: { name: true, fieldType: true } },
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

    const safeOccupants = occupantRows.flatMap((row) => {
      if (
        row.companyId !== companyId ||
        row.asset.companyId !== companyId ||
        row.asset.id !== row.assetId ||
        row.assetField.fieldType !== 'IP_ADDRESS' ||
        typeof row.value !== 'string'
      ) return [];
      const ip = normalizeIpv4V4(row.value.split('/', 1)[0]!.trim());
      if (!ip) return [];
      return [{
        ipAddress: ip,
        assetLabel: boundedText(row.asset.name, 200, 'Asset'),
        interfaceLabel: boundedText(row.assetField.name, 200, 'IP address'),
        assetHref: `/admin/companies/${companyId}/assets/${row.asset.id}`,
      }];
    });

    if (
      subnets.length * safeOccupants.length >
      COMPANY_EXPORT_LIMITS.ipamMembershipChecks
    ) {
      throw new Error('IPAM occupant matching exceeded the bounded export limit.');
    }

    return subnets
      .map((subnet) => {
        if (subnet.companyId !== companyId) {
          throw new Error('Inconsistent IPAM export scope.');
        }
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
            .filter((occupant) => ipInCidr(occupant.ipAddress, subnet.cidr))
            .sort((left, right) => compareIpv4(left.ipAddress, right.ipAddress) ||
              left.assetLabel.localeCompare(right.assetLabel) ||
              left.interfaceLabel.localeCompare(right.interfaceLabel)),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.cidr.localeCompare(right.cidr));
  }

  private async fetchRelations(companyId: string): Promise<ExportRelation[]> {
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
    const [assets, articles, passwords] = await Promise.all([
      idsByType.asset.length > 0
        ? this.prisma.asset.findMany({
            where: { companyId, id: { in: idsByType.asset }, archivedAt: null },
            select: { id: true, companyId: true, name: true },
          })
        : [],
      idsByType.article.length > 0
        ? this.prisma.article.findMany({
            where: { companyId, id: { in: idsByType.article }, archivedAt: null },
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
        return source && target
          ? [{
              relationType: boundedText(row.relationType, 128, 'related_to'),
              source,
              target,
              createdAt: row.createdAt,
            }]
          : [];
      })
      .sort((left, right) => left.relationType.localeCompare(right.relationType) ||
        left.source.label.localeCompare(right.source.label) ||
        left.target.label.localeCompare(right.target.label));
  }

  private async fetchReconstruction(companyId: string): Promise<CompanyExportData['reconstruction']> {
    const [summaryRows, gapRows, provenanceRows] = await Promise.all([
      this.prisma.integrationReconstructionSummary.findMany({
        where: { companyId, resourceId: { not: null } },
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
      this.prisma.integrationSyncRecord.findMany({
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
    assertWithinExportLimit(
      provenanceRows,
      COMPANY_EXPORT_LIMITS.provenance,
      'Source provenance',
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
        target: safeExportTarget(companyId, row.syncRecord),
      };
    }).sort((left, right) => left.kind.localeCompare(right.kind) ||
      left.resourceLabel.localeCompare(right.resourceLabel) ||
      left.message.localeCompare(right.message));

    const provenance = provenanceRows.flatMap((row) => {
      const parsed = integrationProvenanceSchema.safeParse(row.provenance);
      const integration = row.companyMapping.integration;
      if (
        !parsed.success ||
        row.companyId !== companyId ||
        row.companyMapping.companyId !== companyId ||
        row.resource.integrationId !== integration.id ||
        parsed.data.integrationId !== integration.id ||
        parsed.data.resourceKey !== row.resource.resourceKey ||
        parsed.data.state !== row.state
      ) return [];
      const target = safeExportTarget(companyId, row);
      if (!target) return [];
      return [{
        sourceLabel: boundedText(integration.name, 256, 'Integration'),
        sourceResource: boundedText(row.resource.resourceKey, 256, 'resource'),
        ownership: parsed.data.ownership,
        state: row.state,
        firstSeenAt: new Date(parsed.data.firstSeenAt),
        lastSeenAt: new Date(parsed.data.lastSeenAt),
        lastSyncedAt: parsed.data.lastSyncedAt ? new Date(parsed.data.lastSyncedAt) : null,
        staleSince: row.staleSince,
        target,
      }];
    }).sort((left, right) => left.target.label.localeCompare(right.target.label) ||
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
): ExportNativeTarget | null {
  if (!record || record.companyId !== companyId) return null;
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

function boundedText(value: string, limit: number, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? [...trimmed].slice(0, limit).join('') : fallback;
}

function boundedNullableText(value: string | null, limit: number): string | null {
  if (value === null) return null;
  return [...value].slice(0, limit).join('');
}
