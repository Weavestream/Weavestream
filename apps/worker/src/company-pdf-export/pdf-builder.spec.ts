import {
  articleSegmentsFromTiptap,
  buildCompanyExportPdf,
  formatAssetFieldValue,
  pdfEmbedSizeBlockReason,
  pdfSafeUserText,
  richTextToPlaintext,
} from './pdf-builder.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CompanyExportData } from '../../../api/src/exports/company-export-data.service.js';
import {
  companyPdfTestFixture,
  FIXTURE_BLOCKED_SECRET,
} from './company-pdf-export.test-fixture.js';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPLOAD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('PDF export formatting helpers', () => {
  it('resolves asset reference UUIDs to names', () => {
    expect(
      formatAssetFieldValue({
        label: 'Parent',
        fieldType: 'ASSET_REFERENCE',
        value: [UPLOAD_ID, 'cccccccc-cccc-cccc-cccc-cccccccccccc'],
        referenceLabels: { [UPLOAD_ID]: 'Primary firewall' },
      }),
    ).toBe('Primary firewall, cccccccc-cccc-cccc-cccc-cccccccccccc');
  });

  it('resolves TAGS UUIDs to tag names', () => {
    const TAG_A = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const TAG_B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    expect(
      formatAssetFieldValue({
        label: 'Tags',
        fieldType: 'TAGS',
        value: [TAG_A, TAG_B],
        referenceLabels: { [TAG_A]: 'Production', [TAG_B]: 'Critical' },
      }),
    ).toBe('Production, Critical');
  });

  it('flattens rich text docs instead of stringifying JSON', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Connect through the VPN.' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Then open RDP.' }],
        },
      ],
    };

    expect(richTextToPlaintext(doc)).toBe('Connect through the VPN.\nThen open RDP.');
    expect(richTextToPlaintext({ v: doc })).toBe(
      'Connect through the VPN.\nThen open RDP.',
    );
  });

  it('turns Tiptap image nodes into image segments, not filename text', () => {
    const segments = articleSegmentsFromTiptap({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Before image' }],
        },
        {
          type: 'image',
          attrs: {
            src: `/api/v1/companies/${COMPANY_ID}/uploads/${UPLOAD_ID}/image`,
            alt: '94a9686619cabcaa31ab5d59308af037.png',
          },
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'After image' }],
        },
      ],
    });

    expect(segments).toEqual([
      { kind: 'text', text: 'Before image\n' },
      {
        kind: 'image',
        uploadId: UPLOAD_ID,
        fallbackLabel: '94a9686619cabcaa31ab5d59308af037.png',
      },
      { kind: 'text', text: 'After image\n' },
    ]);
  });
});

describe('pdfEmbedSizeBlockReason (WS-027 decompression-bomb gate)', () => {
  it('blocks images above the pixel cap', () => {
    expect(pdfEmbedSizeBlockReason(10000, 6000)).toBe('image too large to embed');
  });

  it('allows images at exactly the pixel cap (strict >)', () => {
    expect(pdfEmbedSizeBlockReason(10000, 5000)).toBeNull();
  });

  it('fails closed on unknown dimensions', () => {
    expect(pdfEmbedSizeBlockReason(null, null)).toBe('image dimensions unavailable');
    expect(pdfEmbedSizeBlockReason(1000, null)).toBe('image dimensions unavailable');
    expect(pdfEmbedSizeBlockReason(undefined, 1000)).toBe('image dimensions unavailable');
  });

  it('allows ordinary photo dimensions', () => {
    expect(pdfEmbedSizeBlockReason(8000, 6000)).toBeNull();
  });
});

describe('standalone reconstruction dossier PDF', () => {
  it('renders essential IPAM, topology, procedures, provenance, dates, and safe gaps as text', async () => {
    const pdf = await buildCompanyExportPdf(companyPdfTestFixture());
    const text = extractPdfText(pdf);

    expect(text).toContain('APP-01 Reconstruction Procedure');
    expect(text).toContain('Install Windows Server from verified media.');
    expect(text).toContain('IP Address Management');
    expect(text).toContain('Core Réseau');
    expect(text).toContain('10.20.30.0/24');
    expect(text).toContain('10.20.30.10');
    expect(text).toContain('APP-01 static address');
    expect(text).toContain('Ethernet 0');
    expect(text).toContain('Relationships / Topology');
    expect(text).toContain('depends on');
    expect(text).toContain('WEB-01');
    expect(text).toContain('device interface ip');
    expect(text).toContain('Reconstruction Dossier');
    expect(text).toMatch(/Synchronized current/i);
    expect(text).toContain('A credential-bearing procedure requires manual documentation.');
    expect(text).toMatch(/Stale since/i);
    expect(text).toContain('Jul 14, 2026');
    expect(text).toContain('München Café Systems');
    expect(text).not.toContain(FIXTURE_BLOCKED_SECRET);
  });

  it('renders explicit empty-state sections', async () => {
    const pdf = await buildCompanyExportPdf(companyPdfTestFixture({
      assets: [],
      articles: [],
      ipam: [],
      relations: [],
      reconstruction: { summaries: [], gaps: [], provenance: [] },
    }));
    const text = extractPdfText(pdf);

    expect(text).toContain('IP Address Management');
    expect(text).toContain('No subnets or address assignments.');
    expect(text).toContain('Relationships / Topology');
    expect(text).toContain('No relationships or dependency links.');
    expect(text).toContain('Reconstruction Dossier');
    expect(text).toContain('No reconstruction summaries, gaps, or source provenance.');
  });

  it('paginates long tables and wraps long safe messages with continuation context', async () => {
    const base = companyPdfTestFixture();
    const longSafeMessage =
      'Document the ordered restoration validation steps for this application service. '.repeat(18).trim();
    const data: CompanyExportData = {
      ...base,
      ipam: [{
        ...base.ipam[0]!,
        reservations: Array.from({ length: 90 }, (_, index) => ({
          ipAddress: `10.20.30.${index + 10}`,
          label: `Reserved endpoint ${String(index).padStart(3, '0')}`,
          notes: index === 89 ? 'Final reservation row' : null,
        })),
        occupants: [],
      }],
      relations: Array.from({ length: 90 }, (_, index) => ({
        ...base.relations[0]!,
        relationType: `depends_on_${String(index).padStart(3, '0')}`,
        source: { ...base.relations[0]!.source, label: `WEB-${String(index).padStart(3, '0')}` },
      })),
      reconstruction: {
        ...base.reconstruction,
        gaps: Array.from({ length: 20 }, (_, index) => ({
          ...base.reconstruction.gaps[0]!,
          kind: index % 2 === 0 ? 'missing_dependency' as const : 'unsupported' as const,
          message: `${index + 1}. ${longSafeMessage}`,
        })),
      },
    };

    const pdf = await buildCompanyExportPdf(data);
    const { text, pages } = inspectPdf(pdf);

    expect(pages).toBeGreaterThan(8);
    expect(text).toContain('IP Address Management (continued)');
    expect(text).toContain('Relationships / Topology (continued)');
    expect(text).toContain('Reconstruction Dossier (continued)');
    expect(text).toContain('Final reservation row');
    expect(text).toContain('Document the ordered restoration validation steps');
  });

  it('preserves existing plaintext-password and article-image fallback behavior', async () => {
    const base = companyPdfTestFixture();
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      articles: [...base.articles, {
        id: '00000000-0000-4000-8000-000000000099',
        title: 'Diagram Notes',
        folderPath: '/',
        editorMode: 'tiptap',
        content: {
          type: 'doc',
          content: [{
            type: 'image',
            attrs: {
              src: `/api/v1/companies/${COMPANY_ID}/uploads/${UPLOAD_ID}/image`,
              alt: 'network-diagram.gif',
            },
          }],
        },
        markdownSource: null,
        contentPlaintext: null,
        images: [{
          uploadId: UPLOAD_ID,
          filename: 'network-diagram.gif',
          mimeType: 'image/gif',
          storageKey: 'fixture/image',
          width: 100,
          height: 100,
        }],
        updatedAt: base.exportedAt,
      }],
    };

    const text = extractPdfText(await buildCompanyExportPdf(data));

    expect(text).toContain('Passwords (Plaintext)');
    expect(text).toContain(FIXTURE_BLOCKED_SECRET);
    expect(text).toContain('APP-01 Reconstruction Procedure');
    expect(text).toContain('network-diagram.gif - image/gif is not embeddable');
  });

  it('embeds deterministic Unicode fonts and applies the explicit emoji fallback', async () => {
    const base = companyPdfTestFixture();
    const data: CompanyExportData = {
      ...base,
      company: { ...base.company, name: '東京復旧 株式会社 Пример восстановления 😀' },
      articles: [{
        ...base.articles[0]!,
        title: '復旧手順 — Процедура',
        contentPlaintext: 'サーバーを復元します。 Проверить сеть. 😀',
      }],
      relations: [{
        ...base.relations[0]!,
        source: { ...base.relations[0]!.source, label: 'ウェブサーバー' },
        target: { ...base.relations[0]!.target, label: 'База данных' },
      }],
      reconstruction: {
        ...base.reconstruction,
        gaps: [{
          ...base.reconstruction.gaps[0]!,
          resourceLabel: 'ネットワーク Восстановление',
          message: '静的アドレスを確認してください。 Проверить маршрут.',
        }],
      },
    };

    const pdf = await buildCompanyExportPdf(data);
    const text = extractPdfText(pdf);
    const fonts = inspectPdfFonts(pdf);

    const compactText = text.replace(/\s+/g, '');
    for (const expected of [
      '東京復旧 株式会社 Пример восстановления',
      '復旧手順',
      'Процедура',
      'サーバーを復元します。',
      'Проверить сеть.',
      'ウェブサーバー',
      'База данных',
      'ネットワーク Восстановление',
      '静的アドレスを確認してください。',
    ]) expect(compactText).toContain(expected.replace(/\s+/g, ''));
    expect(text).toContain('[U+1F600]');
    expect(text).not.toContain('😀');
    expect(text).not.toContain('�');
    expect(fonts).toMatch(/Noto/i);
    expect(fonts).not.toMatch(/\bno\b/i);
  });

  it('renders emoji credentials reversibly and unsupported prose deterministically', async () => {
    const base = companyPdfTestFixture();
    const password = 'Pass😀-1️⃣-🇺🇸';
    const totp = 'OTP😀-1️⃣-🇺🇸';
    const notes = 'Notes 😀 1️⃣ 🇺🇸';
    const arabic = 'مرحبا';
    const hebrew = 'שלום';
    const devanagari = 'नमस्ते';
    const thai = 'สวัสดี';
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      company: { ...base.company, quickNotes: `Arabic ${arabic} Hebrew ${hebrew}` },
      passwords: [{ ...base.passwords[0]!, password, totpSecret: totp, notes }],
      articles: [{ ...base.articles[0]!, contentPlaintext: `Devanagari ${devanagari}` }],
      reconstruction: {
        ...base.reconstruction,
        gaps: [{ ...base.reconstruction.gaps[0]!, message: `Thai ${thai}` }],
      },
    };

    const first = await buildCompanyExportPdf(data);
    const second = await buildCompanyExportPdf(data);
    const text = extractPdfText(first);

    for (const value of [password, totp, notes, arabic, hebrew, devanagari, thai]) {
      const encoded = pdfSafeUserText(value);
      expect(decodePdfNotation(encoded)).toBe(value);
      expect(text.replace(/\s+/g, '')).toContain(encoded.replace(/\s+/g, ''));
    }
    expect(text).toContain('[U+1F600]');
    expect(text).toContain('[U+0031+FE0F+20E3]');
    expect(text).toContain('[U+1F1FA+1F1F8]');
    expect(text).not.toContain('�');
    expect(createHash('sha256').update(first).digest('hex'))
      .toBe(createHash('sha256').update(second).digest('hex'));
  });

  it('labels stale-bound records unmistakably as last-known stale', async () => {
    const base = companyPdfTestFixture();
    const stale = {
      state: 'stale' as const,
      staleSince: new Date('2026-07-14T00:30:00.000Z'),
      sourceLabel: 'Breeze',
    };
    const pdf = await buildCompanyExportPdf({
      ...base,
      assets: base.assets.map((asset) => ({ ...asset, reconstructionState: stale })),
      articles: base.articles.map((article) => ({ ...article, reconstructionState: stale })),
      ipam: base.ipam.map((subnet) => ({ ...subnet, reconstructionState: stale })),
      relations: base.relations.map((relation, index) => index === 0
        ? { ...relation, reconstructionState: stale }
        : relation),
    });
    const text = extractPdfText(pdf);

    expect(text.match(/LAST-KNOWN STALE/g)).toHaveLength(4);
    expect(text).toContain('Stale since Jul 14, 2026 UTC');
  });

  it('keeps UTC dates and the PDF hash invariant across process timezones', async () => {
    const originalTimezone = process.env['TZ'];
    const base = companyPdfTestFixture({
      exportedAt: new Date('2026-07-14T00:30:00.000Z'),
      company: {
        ...companyPdfTestFixture().company,
        createdAt: new Date('2026-07-14T00:30:00.000Z'),
      },
    });
    try {
      process.env['TZ'] = 'UTC';
      const utc = await buildCompanyExportPdf(base);
      process.env['TZ'] = 'America/Denver';
      const denver = await buildCompanyExportPdf(base);

      expect(createHash('sha256').update(denver).digest('hex'))
        .toBe(createHash('sha256').update(utc).digest('hex'));
      expect(extractPdfText(utc)).toContain('Jul 14, 2026 UTC');
      expect(extractPdfText(denver)).toContain('Jul 14, 2026 UTC');
    } finally {
      if (originalTimezone === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTimezone;
    }
  });

  it('paginates maximum-size gap headings, messages, and footers as measured cards', async () => {
    const base = companyPdfTestFixture();
    const resourceLabel = `MAX-LABEL-${'界'.repeat(246)}`;
    const targetLabel = `MAX-TARGET-${'Ж'.repeat(245)}`;
    const message = `MAX-MESSAGE-${'restore validation step '.repeat(24)}`.slice(0, 512);
    const pdf = await buildCompanyExportPdf({
      ...base,
      reconstruction: {
        ...base.reconstruction,
        provenance: Array.from({ length: 8 }, (_, index) => ({
          ...base.reconstruction.provenance[0]!,
          target: { ...base.reconstruction.provenance[0]!.target, label: `Lead record ${index}` },
        })),
        gaps: [
          { ...base.reconstruction.gaps[0]!, resourceLabel, message, target: { ...base.reconstruction.gaps[0]!.target!, label: targetLabel } },
          { ...base.reconstruction.gaps[0]!, resourceLabel: 'FOLLOWING GAP CARD', message: 'FOLLOWING MESSAGE' },
        ],
      },
    });
    const { text, pages } = inspectPdf(pdf);

    expect(pages).toBeGreaterThan(8);
    expect((text.match(/界/g) ?? [])).toHaveLength(246);
    const compactText = text.replace(/\s+/g, '');
    expect(compactText).toContain(message.replace(/\s+/g, ''));
    expect(compactText).toContain(targetLabel.replace(/\s+/g, ''));
    expect(text).toContain('FOLLOWING GAP CARD');
    expect(text.indexOf('FOLLOWING GAP CARD')).toBeGreaterThan(text.indexOf('MAX-MESSAGE'));
    expect(text).toMatch(/Page \d+ of \d+/);
  });

  it('builds a deterministic inspection fixture and optionally writes it under tmp/pdfs', async () => {
    const first = await buildCompanyExportPdf(strengthenedInspectionFixture());
    const second = await buildCompanyExportPdf(strengthenedInspectionFixture());
    expect(createHash('sha256').update(first).digest('hex'))
      .toBe(createHash('sha256').update(second).digest('hex'));

    const requestedOutput = process.env['WEAVESTREAM_PDF_FIXTURE_OUTPUT'];
    if (requestedOutput) {
      const output = resolve(repoRoot(), requestedOutput);
      mkdirSync(resolve(output, '..'), { recursive: true });
      writeFileSync(output, first);
    }
  });

  it('removes only its empty scoped Poppler inspection directories', async () => {
    inspectPdf(await buildCompanyExportPdf(companyPdfTestFixture()));
    const pdfRoot = resolve(repoRoot(), 'tmp/pdfs');
    const entries = existsSync(pdfRoot) ? readdirSync(pdfRoot) : [];
    expect(entries.filter((entry) => /^jest-|^task-10-jest/.test(entry))).toEqual([]);
    expect(existsSync(resolve(pdfRoot, `task-10-jest-${process.pid}`))).toBe(false);
  });
});

function extractPdfText(pdf: Buffer): string {
  return inspectPdf(pdf).text;
}

function inspectPdf(pdf: Buffer): { text: string; pages: number } {
  return withPopplerPdf(pdf, (input) => {
    const text = execFileSync('pdftotext', [input, '-'], { encoding: 'utf8' });
    const info = execFileSync('pdfinfo', [input], { encoding: 'utf8' });
    const pages = Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1] ?? '0');
    return { text, pages };
  });
}

function inspectPdfFonts(pdf: Buffer): string {
  return withPopplerPdf(pdf, (input) =>
    execFileSync('pdffonts', [input], { encoding: 'utf8' }),
  );
}

function withPopplerPdf<T>(pdf: Buffer, inspect: (input: string) => T): T {
  const tmpRoot = resolve(repoRoot(), 'tmp');
  const pdfRoot = resolve(tmpRoot, 'pdfs');
  const scope = resolve(pdfRoot, `task-10-jest-${process.pid}`);
  const createdTmpRoot = !existsSync(tmpRoot);
  const createdPdfRoot = !existsSync(pdfRoot);
  mkdirSync(scope, { recursive: true });
  const dir = mkdtempSync(resolve(scope, 'inspection-'));
  const input = resolve(dir, 'fixture.pdf');
  try {
    writeFileSync(input, pdf);
    return inspect(input);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    removeEmptyDirectory(scope);
    if (createdPdfRoot) removeEmptyDirectory(pdfRoot);
    if (createdTmpRoot) removeEmptyDirectory(tmpRoot);
  }
}

function removeEmptyDirectory(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // ENOTEMPTY means another concurrent inspection owns an artifact.
  }
}

function repoRoot(): string {
  return resolve(process.cwd(), '../..');
}

function strengthenedInspectionFixture(): CompanyExportData {
  const base = companyPdfTestFixture();
  const stale = {
    state: 'stale' as const,
    staleSince: new Date('2026-07-14T00:30:00.000Z'),
    sourceLabel: 'Breeze',
  };
  return {
    ...base,
    company: {
      ...base.company,
      name: '東京復旧 株式会社 — Пример восстановления',
      quickNotes: 'Arabic مرحبا · Hebrew שלום',
    },
    includePasswords: true,
    passwords: base.passwords.map((password) => ({
      ...password,
      password: 'Pass😀-1️⃣-🇺🇸',
      totpSecret: 'OTP😀-1️⃣-🇺🇸',
      notes: 'Reversible notes 😀 1️⃣ 🇺🇸',
    })),
    assets: base.assets.map((asset) => ({
      ...asset,
      reconstructionState: stale,
      fields: [...asset.fields, {
        label: 'Offline recovery role',
        fieldType: 'TEXT',
        value: '復旧サーバー — Сервер восстановления',
      }],
    })),
    articles: base.articles.map((article) => ({
      ...article,
      title: '復旧手順 — Процедура восстановления',
      contentPlaintext: `${article.contentPlaintext ?? ''}\nサーバーを復元します。 Проверить сеть. 😀 1️⃣ 🇺🇸\nDevanagari नमस्ते · Thai สวัสดี`,
      reconstructionState: stale,
    })),
    ipam: base.ipam.map((subnet) => ({ ...subnet, reconstructionState: stale })),
    relations: base.relations.map((relation, index) => index === 0
      ? { ...relation, reconstructionState: stale }
      : relation),
    reconstruction: {
      ...base.reconstruction,
      provenance: Array.from({ length: 8 }, (_, index) => ({
        ...base.reconstruction.provenance[0]!,
        target: { ...base.reconstruction.provenance[0]!.target, label: `Last-known device ${index}` },
      })),
      gaps: [
        {
          ...base.reconstruction.gaps[0]!,
          resourceLabel: `MAX-LABEL-${'界'.repeat(246)}`,
          message: `MAX-MESSAGE-${'restore validation step '.repeat(24)}`.slice(0, 512),
          target: {
            ...base.reconstruction.gaps[0]!.target!,
            label: `MAX-TARGET-${'Ж'.repeat(245)}`,
          },
        },
        {
          ...base.reconstruction.gaps[0]!,
          resourceLabel: 'FOLLOWING GAP CARD',
          message: 'FOLLOWING MESSAGE — 静的アドレスを確認してください。',
        },
      ],
    },
  };
}

function decodePdfNotation(value: string): string {
  return value.replace(/\[U\+([0-9A-F]+(?:\+[0-9A-F]+)*)\]/g, (_match, codes: string) =>
    String.fromCodePoint(...codes.split('+').map((code) => Number.parseInt(code, 16))),
  );
}
