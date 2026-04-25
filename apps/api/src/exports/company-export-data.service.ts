import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SecretEncryptionService } from '../crypto/secret-encryption.service.js';

// ---------------------------------------------------------------------------
// Export data shapes
// ---------------------------------------------------------------------------

export interface ExportCompany {
  id: string;
  name: string;
  slug: string;
  type: string;
  notes: string | null;
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
  value: unknown;
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
  notes: string | null;
  totpSecret: string | null;
  lastRotatedAt: Date | null;
  expiresAt: Date | null;
  pwnedCount: number | null;
}

export interface ExportArticle {
  title: string;
  folderPath: string;
  contentPlaintext: string | null;
  updatedAt: Date;
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
    const [company, memberships, assets, articles, passwords, domains, uploads] =
      await Promise.all([
        this.fetchCompany(companyId),
        this.fetchMembers(companyId),
        this.fetchAssets(companyId),
        this.fetchArticles(companyId),
        this.fetchPasswords(companyId, opts.includePasswords),
        this.fetchDomains(companyId),
        this.fetchUploads(companyId),
      ]);

    if (!company) throw new Error(`Company ${companyId} not found`);

    return {
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

  private async fetchCompany(companyId: string): Promise<ExportCompany | null> {
    const row = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: {
        id: true,
        name: true,
        slug: true,
        type: true,
        notes: true,
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
            assetField: { select: { name: true } },
          },
        },
      },
      orderBy: [{ assetLayout: { name: 'asc' } }, { name: 'asc' }],
    });
    return rows.map((a) => ({
      name: a.name,
      layoutName: a.assetLayout.name,
      fields: a.fieldValues.map((fv) => ({
        label: fv.assetField.name,
        value: fv.value,
      })),
    }));
  }

  private async fetchArticles(companyId: string): Promise<ExportArticle[]> {
    const rows = await this.prisma.article.findMany({
      where: { companyId, archivedAt: null },
      select: {
        title: true,
        contentPlaintext: true,
        updatedAt: true,
        folder: { select: { name: true } },
      },
      orderBy: [{ folder: { name: 'asc' } }, { title: 'asc' }],
    });
    return rows.map((a) => ({
      title: a.title,
      folderPath: a.folder?.name ?? '/',
      contentPlaintext: a.contentPlaintext,
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

      let notes: string | null = null;
      if (p.notesCiphertext) {
        try {
          notes = this.crypto.decrypt(p.notesCiphertext);
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
