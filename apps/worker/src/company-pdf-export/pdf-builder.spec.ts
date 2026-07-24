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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import type { CompanyExportData } from '../../../api/src/exports/company-export-data.service.js';
import {
  companyPdfTestFixture,
  FIXTURE_BLOCKED_SECRET,
} from './company-pdf-export.test-fixture.js';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPLOAD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('vendored PDF fonts', () => {
  it.each([
    [
      'NotoSansCJKjp-Regular.otf',
      '68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5',
    ],
    [
      'NotoSansCJKjp-Bold.otf',
      'e53dcb0dcb2922e45d01aae1ebd2f382bb81d4229b18b6b883bd170678af1f76',
    ],
  ])('matches the recorded SHA-256 for %s', (filename, expected) => {
    const font = readFileSync(resolve(__dirname, 'fonts', filename));
    expect(createHash('sha256').update(font).digest('hex')).toBe(expected);
  });
});

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

  it('flags unrenderable credentials explicitly and encodes prose deterministically', async () => {
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
    // CR-020: unrenderable credentials never print silently mutated —
    // the password and TOTP cards each carry the explicit encoding note.
    expect(text.match(/Not literal/g) ?? []).toHaveLength(2);
    expect(text).toContain('[U+1F600]');
    expect(text).toContain('[U+0031+FE0F+20E3]');
    expect(text).toContain('[U+1F1FA+1F1F8]');
    expect(text).not.toContain('�');
    expect(createHash('sha256').update(first).digest('hex'))
      .toBe(createHash('sha256').update(second).digest('hex'));
  });

  it('renders literal-notation credentials byte-exact and flags encoded ones apart', async () => {
    const base = companyPdfTestFixture();
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      passwords: [
        {
          ...base.passwords[0]!,
          name: 'Literal notation',
          password: 'Pass[U+1F600]',
          totpSecret: 'OTP[U+0031+FE0F+20E3]',
          notes: 'Notes [U+1F600] [U+0031+FE0F+20E3] [[',
        },
        {
          ...base.passwords[0]!,
          name: 'Encoded graphemes',
          password: 'Pass😀',
          totpSecret: 'OTP1️⃣',
          notes: 'Notes 😀 [[',
        },
      ],
    };

    const text = extractPdfText(await buildCompanyExportPdf(data));

    // A credential that literally contains the notation renders
    // byte-exact — no bracket doubling (CR-020).
    expect(text).not.toContain('Pass[[U+1F600]');
    expect(text).not.toContain('OTP[[U+0031+FE0F+20E3]');
    // The unrenderable credential draws the same marker string, so both
    // cards show it; the warning note is what tells them apart.
    expect(text.match(/Pass\[U\+1F600\]/g) ?? []).toHaveLength(2);
    expect(text.match(/OTP\[U\+0031\+FE0F\+20E3\]/g) ?? []).toHaveLength(2);
    expect(text.match(/Not literal/g) ?? []).toHaveLength(2);
    // Notes are prose: they keep the reversible display notation.
    expect(text).toContain('Notes [[U+1F600] [[U+0031+FE0F+20E3] [[[[');
    expect(text).toContain('Notes [U+1F600] [[[[');
    expect(decodePdfNotation('Notes [U+1F600] [[[[')).toBe('Notes 😀 [[');
  });

  it('renders packaged-font credentials byte-exact without escape notation', async () => {
    const base = companyPdfTestFixture();
    const password = 'Pa[ss]word-[[x]]-€céntr-木';
    const totp = 'JBSWY3DPEHPK3PXP';
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      passwords: [{ ...base.passwords[0]!, password, totpSecret: totp }],
    };

    const text = extractPdfText(await buildCompanyExportPdf(data));

    expect(text).toContain(password);
    expect(text).toContain(totp);
    expect(text).not.toContain('Pa[[ss]word');
    expect(text).not.toContain('Not literal');
  });

  it('encodes control and formatting characters in credentials instead of normalizing them', async () => {
    const base = companyPdfTestFixture();
    // Tab, zero-width space, NBSP, and soft hyphen all "render" but are
    // normalized or dropped by PDF layout/extraction — the literal path
    // must reject them and the encoded form must mark every one.
    const password = 'A\tB\u200Bc\u00A0d\u00ADe';
    const totp = 'OTP\nQR';
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      passwords: [{ ...base.passwords[0]!, password, totpSecret: totp }],
    };

    const text = extractPdfText(await buildCompanyExportPdf(data));

    expect(text).toContain('A[U+0009]B[U+200B]c[U+00A0]d[U+00AD]e');
    expect(text).toContain('OTP[U+000A]QR');
    expect(text.match(/Not literal/g) ?? []).toHaveLength(2);
    expect(decodePdfNotation('A[U+0009]B[U+200B]c[U+00A0]d[U+00AD]e')).toBe(password);
    expect(decodePdfNotation('OTP[U+000A]QR')).toBe(totp);
  });

  it('rejects default-ignorable and unassigned code points from the literal credential path', async () => {
    const base = companyPdfTestFixture();
    // U+034F (Combining Grapheme Joiner) is a Mark that extraction
    // rewrites; U+2065 is unassigned but default-ignorable. Both sit
    // inside packaged font ranges, so only the fail-closed whitelist
    // keeps them off the literal path.
    const password = 'a\u034Fb\u2065c';
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      passwords: [{ ...base.passwords[0]!, password }],
    };

    const text = extractPdfText(await buildCompanyExportPdf(data));

    expect(text).toContain('[U+0061+034F]b[U+2065]c');
    expect(text.match(/Not literal/g) ?? []).toHaveLength(1);
    expect(decodePdfNotation('[U+0061+034F]b[U+2065]c')).toBe(password);
  });

  it('rejects range-approved code points the packaged fonts cannot actually draw', async () => {
    const base = companyPdfTestFixture();
    // U+0104 sits in Latin Extended-A, inside the approved ranges, but
    // Noto Sans CJK JP ships no glyph for it - rendered literally it
    // draws .notdef and extracts as a space. Only the font's own cmap
    // can prove coverage.
    const password = 'A\u0104B';
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      company: { ...base.company, quickNotes: 'Ogonek \u0104 probe' },
      passwords: [{ ...base.passwords[0]!, password }],
    };

    const text = extractPdfText(await buildCompanyExportPdf(data));

    expect(text).toContain('A[U+0104]B');
    expect(text.match(/Not literal/g) ?? []).toHaveLength(1);
    expect(decodePdfNotation('A[U+0104]B')).toBe(password);
    // Prose shares the cmap gate: a readable marker instead of tofu.
    expect(text).toContain('Ogonek [U+0104] probe');
  });

  it('parses serialized rich-text notes and fields before display encoding', async () => {
    const base = companyPdfTestFixture();
    const serialized = JSON.stringify({
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{ type: 'text', text: 'Rotate quarterly [ops] 😀' }],
      }],
    });
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      passwords: [{ ...base.passwords[0]!, notes: serialized }],
      assets: [{
        ...base.assets[0]!,
        fields: [
          ...base.assets[0]!.fields,
          { label: 'Runbook', fieldType: 'RICH_TEXT', value: serialized },
        ],
      }],
    };

    const text = extractPdfText(await buildCompanyExportPdf(data));

    // The serialized Tiptap JSON must parse (the old whole-DTO encode
    // pass doubled its brackets first, so JSON.parse failed and the raw
    // mangled JSON rendered as prose).
    const compact = text.replace(/\s+/g, '');
    expect(compact.match(/Rotatequarterly\[\[ops\]\[U\+1F600\]/g) ?? []).toHaveLength(2);
    expect(text).not.toContain('"type"');
  });

  it('encrypts password-protected exports with AES-256 and requires the password', async () => {
    const password = 'correct-horse-battery-staple';
    const pdf = await buildCompanyExportPdf(companyPdfTestFixture(), {
      pdfPassword: password,
    });

    // The /Encrypt dictionary is necessarily plaintext in the file.
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/AESV3');
    expect(raw).toContain('/V 5');
    expect(raw).toContain('/R 5');

    const { lockedError, text, info } = inspectEncryptedPdf(pdf, password);
    expect(lockedError).toMatch(/password/i);
    expect(info).toMatch(/algorithm:AES-256/);
    expect(text).toContain('Vault Archive');
    expect(text).toContain('München Café Systems');
  });

  it('sanitizes XML-special company names out of metadata but not page content', async () => {
    const password = 'correct-horse-battery-staple';
    const base = companyPdfTestFixture();
    const data: CompanyExportData = {
      ...base,
      company: { ...base.company, name: 'A & B <Ops> Café\uFFFE\uFFFF' },
    };

    const encrypted = await buildCompanyExportPdf(data, { pdfPassword: password });
    const { text, info, meta } = inspectEncryptedPdf(encrypted, password);

    // Page content keeps the exact name; the Info/XMP title is stripped
    // of XML-special characters because PDFKit interpolates the XMP
    // packet without escaping.
    expect(text).toContain('A & B <Ops> Café');
    expect(info).toContain('Vault Export - A B Ops Café');
    expect(meta).toContain('<dc:title>');
    expect(meta).toContain('Vault Export - A B Ops Café');
    expect(meta).not.toContain('& B');
    expect(meta).not.toContain('<Ops>');

    // Substrings are not proof of well-formedness (U+FFFE would pass
    // them) - the packet must parse as XML.
    const packet = meta.slice(meta.indexOf('<?xpacket'), meta.lastIndexOf('?>') + 2);
    expect(packet).toContain('<x:xmpmeta');
    expect(() =>
      execFileSync('xmllint', ['--noout', '-'], { input: packet, encoding: 'utf8' }),
    ).not.toThrow();

    // Unencrypted exports stay PDF 1.3 and never emit an XMP packet.
    const plain = await buildCompanyExportPdf(data);
    expect(plain.toString('latin1')).not.toContain('/Metadata');
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

function inspectEncryptedPdf(
  pdf: Buffer,
  password: string,
): { lockedError: string; text: string; info: string; meta: string } {
  return withPopplerPdf(pdf, (input) => {
    let lockedError = '';
    try {
      execFileSync('pdftotext', [input, '-'], { encoding: 'utf8' });
    } catch (err) {
      lockedError = String((err as { stderr?: unknown }).stderr ?? err);
    }
    const text = execFileSync('pdftotext', ['-upw', password, input, '-'], {
      encoding: 'utf8',
    });
    const info = execFileSync('pdfinfo', ['-upw', password, input], {
      encoding: 'utf8',
    });
    const meta = execFileSync('pdfinfo', ['-meta', '-upw', password, input], {
      encoding: 'utf8',
    });
    return { lockedError, text, info, meta };
  });
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
      password: 'Pass😀-[U+1F600]-1️⃣-🇺🇸',
      totpSecret: 'OTP1️⃣-[U+0031+FE0F+20E3]-[[',
      notes: 'Reversible notes 😀 [U+1F600] 1️⃣ [restore] [[',
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
      contentPlaintext: `${article.contentPlaintext ?? ''}\nサーバーを復元します。 Проверить сеть. 😀 1️⃣ 🇺🇸\nLiteral brackets [restore] and marker [U+1F600].\nDevanagari नमस्ते · Thai สวัสดี`,
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
  let decoded = '';
  for (let index = 0; index < value.length;) {
    if (value.startsWith('[[', index)) {
      decoded += '[';
      index += 2;
      continue;
    }
    const marker = /^\[U\+([0-9A-F]+(?:\+[0-9A-F]+)*)\]/.exec(value.slice(index));
    if (marker) {
      decoded += String.fromCodePoint(
        ...marker[1]!.split('+').map((code) => Number.parseInt(code, 16)),
      );
      index += marker[0].length;
      continue;
    }
    decoded += value[index];
    index += 1;
  }
  return decoded;
}
