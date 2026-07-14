import {
  articleSegmentsFromTiptap,
  buildCompanyExportPdf,
  formatAssetFieldValue,
  pdfEmbedSizeBlockReason,
  richTextToPlaintext,
} from './pdf-builder.js';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('builds a deterministic inspection fixture and optionally writes it under tmp/pdfs', async () => {
    const first = await buildCompanyExportPdf(companyPdfTestFixture());
    const second = await buildCompanyExportPdf(companyPdfTestFixture());
    expect(createHash('sha256').update(first).digest('hex'))
      .toBe(createHash('sha256').update(second).digest('hex'));

    const requestedOutput = process.env['WEAVESTREAM_PDF_FIXTURE_OUTPUT'];
    if (requestedOutput) {
      const output = resolve(repoRoot(), requestedOutput);
      mkdirSync(resolve(output, '..'), { recursive: true });
      writeFileSync(output, first);
    }
  });
});

function extractPdfText(pdf: Buffer): string {
  return inspectPdf(pdf).text;
}

function inspectPdf(pdf: Buffer): { text: string; pages: number } {
  const root = resolve(repoRoot(), 'tmp/pdfs');
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(resolve(root, 'jest-'));
  const input = resolve(dir, 'fixture.pdf');
  try {
    writeFileSync(input, pdf);
    const text = execFileSync('pdftotext', [input, '-'], { encoding: 'utf8' });
    const info = execFileSync('pdfinfo', [input], { encoding: 'utf8' });
    const pages = Number(/^Pages:\s+(\d+)$/m.exec(info)?.[1] ?? '0');
    return { text, pages };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function repoRoot(): string {
  return resolve(process.cwd(), '../..');
}
