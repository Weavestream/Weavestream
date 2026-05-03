import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretEncryptionService } from '../crypto/secret-encryption.service.js';
import { extractEmbeddedUploadIds } from '../articles/article-uploads.js';

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
    const [company, workspaceName, memberships, assets, articles, passwords, domains, uploads] =
      await Promise.all([
        this.fetchCompany(companyId),
        this.fetchWorkspaceName(),
        this.fetchMembers(companyId),
        this.fetchAssets(companyId),
        this.fetchArticles(companyId),
        this.fetchPasswords(companyId, opts.includePasswords),
        this.fetchDomains(companyId),
        this.fetchUploads(companyId),
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
        passwordCiphertext: true,
        notesCiphertext: true,
        totpSecretCiphertext: true,
      },
      orderBy: [{ folder: { name: 'asc' } }, { name: 'asc' }],
    });

    return rows.map((p) => {
      let password: string | null;
      try {
        password = this.crypto.decrypt(p.passwordCiphertext);
      } catch {
        password = '[decryption error]';
      }

      let notes: unknown | null = null;
      if (p.notesCiphertext) {
        try {
          notes = parseJsonIfPossible(this.crypto.decrypt(p.notesCiphertext));
        } catch {
          notes = '[decryption error]';
        }
      }

      let totpSecret: string | null = null;
      if (p.totpSecretCiphertext) {
        try {
          totpSecret = this.crypto.decrypt(p.totpSecretCiphertext);
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
}

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
