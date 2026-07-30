import {
  buildCompanyExportPdf,
  codeCaption,
  formatAssetFieldValue,
  parseMarkdownBlocks,
  pdfEmbedSizeBlockReason,
  pdfSafeUserText,
  richTextToPlaintext,
} from './pdf-builder.js';
import { fenceInfoLanguage, isMermaidLanguage } from '@weavestream/shared';
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
import { delimiter, resolve } from 'node:path';
import type { CompanyExportData } from '../../../api/src/exports/company-export-data.service.js';
import {
  companyPdfTestFixture,
  FIXTURE_BLOCKED_SECRET,
} from './company-pdf-export.test-fixture.js';

const COMPANY_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPLOAD_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/**
 * External oracles these specs read the rendered PDF back with: Poppler
 * (`pdftotext`/`pdfinfo`/`pdffonts`) for text, page counts, embedded fonts
 * and AES-256 encryption, libxml2 (`xmllint`) for the exported XMP packet.
 * Neither ships with Node, so an unprovisioned checkout used to fail two
 * dozen specs with a bare `spawnSync pdftotext ENOENT`.
 *
 * Resolve them once up front instead: without them the inspection specs
 * skip with an install hint, and where they are required — explicit
 * `WEAVESTREAM_REQUIRE_PDF_TOOLS`, else a truthy `CI` — a missing binary
 * is a hard failure, so a provisioning regression can never silently drop
 * the credential-rendering and encryption coverage.
 */
const PDF_INSPECTION_TOOLS = [
  'pdftotext',
  'pdfinfo',
  'pdffonts',
  'xmllint',
] as const;

function resolvesOnPath(binary: string): boolean {
  // Mirrors how execFileSync itself resolves a bare command name.
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
      : [''];
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .some((entry) =>
      extensions.some((extension) =>
        existsSync(resolve(entry, `${binary}${extension}`)),
      ),
    );
}

const missingPdfTools = PDF_INSPECTION_TOOLS.filter(
  (tool) => !resolvesOnPath(tool),
);

const FALSE_ENV_VALUES = ['0', 'false', 'no'];

/** `undefined` when unset or empty, so callers can fall through. */
function envFlag(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === '') return undefined;
  return !FALSE_ENV_VALUES.includes(value);
}

const pdfToolsRequired =
  envFlag('WEAVESTREAM_REQUIRE_PDF_TOOLS') ?? envFlag('CI') ?? false;

function missingPdfToolsMessage(): string {
  return [
    `Missing PDF inspection tools on PATH: ${missingPdfTools.join(', ')}.`,
    'Install them, then re-run this spec:',
    '  Debian/Ubuntu: sudo apt-get install -y poppler-utils libxml2-utils',
    '  macOS (Homebrew): brew install poppler   # xmllint ships with macOS',
    'Set WEAVESTREAM_REQUIRE_PDF_TOOLS=0 to skip the inspection specs.',
  ].join('\n');
}

const itWithPdfTools = missingPdfTools.length === 0 ? it : it.skip;

if (missingPdfTools.length > 0 && !pdfToolsRequired) {
  console.warn(`Skipping PDF inspection specs.\n${missingPdfToolsMessage()}`);
}

describe('PDF inspection tooling', () => {
  // Reports a real signal wherever it can: green once the tools are on
  // PATH, red when they are required and absent. Only an unprovisioned
  // developer machine — where the skip is the point — sits it out.
  const itWhenMeaningful =
    pdfToolsRequired || missingPdfTools.length === 0 ? it : it.skip;

  itWhenMeaningful('resolves Poppler and libxml2 on PATH', () => {
    const status =
      missingPdfTools.length === 0 ? 'all present' : missingPdfToolsMessage();
    expect(status).toBe('all present');
  });
});

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

});

describe('parseMarkdownBlocks', () => {
  it('extracts headings, nested lists, tables, and upload-backed images', () => {
    const blocks = parseMarkdownBlocks([
      '## Steps',
      '',
      '1. First',
      '2. Second',
      '   - nested note',
      '',
      '| A | B |',
      '| --- | --- |',
      '| 1 | pipe \\| kept |',
      '',
      `![diagram.png](/api/v1/companies/${COMPANY_ID}/uploads/${UPLOAD_ID}/image)`,
    ].join('\n'));

    expect(blocks).toEqual([
      { kind: 'heading', level: 2, runs: [{ text: 'Steps' }] },
      {
        kind: 'list',
        items: [
          expect.objectContaining({
            marker: '1.',
            task: null,
            runs: [{ text: 'First' }],
            children: [],
          }),
          expect.objectContaining({
            marker: '2.',
            task: null,
            runs: [{ text: 'Second' }],
            children: [
              {
                kind: 'list',
                items: [
                  expect.objectContaining({
                    marker: '•',
                    runs: [{ text: 'nested note' }],
                  }),
                ],
              },
            ],
          }),
        ],
      },
      { kind: 'table', rows: [['A', 'B'], ['1', 'pipe | kept']] },
      { kind: 'image', uploadId: UPLOAD_ID, label: 'diagram.png' },
    ]);
  });

  it('parses task items and inline styling without leaking syntax', () => {
    const blocks = parseMarkdownBlocks('- [x] Done **now** `code`\n- [ ] Later');

    expect(blocks).toEqual([{
      kind: 'list',
      items: [
        expect.objectContaining({
          task: 'checked',
          runs: [
            { text: 'Done ' },
            { text: 'now', bold: true },
            { text: ' ' },
            { text: 'code', code: true },
          ],
        }),
        expect.objectContaining({ task: 'unchecked', runs: [{ text: 'Later' }] }),
      ],
    }]);
  });

  it('splits table rows on unescaped pipes only (backslash parity)', () => {
    // Cell projections escape backslashes first, then pipes, so:
    //   `\|`  = literal pipe (no split)
    //   `\\|` = literal backslash, then a real delimiter (split)
    //   trailing `\|` without a closing delimiter keeps its cell.
    const blocks = parseMarkdownBlocks([
      '| A | B |',
      '| --- | --- |',
      '| C:\\\\temp\\|dir | plain |',
      '| keep\\\\ | split |',
      'c | trailing\\|',
    ].join('\n'));

    expect(blocks).toEqual([{
      kind: 'table',
      rows: [
        ['A', 'B'],
        ['C:\\temp|dir', 'plain'],
        ['keep\\', 'split'],
        ['c', 'trailing|'],
      ],
    }]);
  });

  it('caps quote/list nesting instead of recursing per level (stack safety)', () => {
    // 40k ">" fits well inside the 500KB article source limit; parsing
    // must not recurse once per marker.
    const deepQuote = `${'>'.repeat(40_000)} bottom`;
    const deepList = Array.from({ length: 200 }, (_, level) =>
      `${' '.repeat(level * 2)}- level ${level}`).join('\n');

    expect(() => parseMarkdownBlocks(deepQuote)).not.toThrow();
    expect(() => parseMarkdownBlocks(deepList)).not.toThrow();

    // Content beyond the cap degrades to text — never dropped.
    expect(JSON.stringify(parseMarkdownBlocks(deepQuote))).toContain('bottom');
    expect(JSON.stringify(parseMarkdownBlocks(deepList))).toContain('level 199');
  });

  it('keeps fenced code verbatim and blockquotes structured', () => {
    const blocks = parseMarkdownBlocks(
      '```bash\npg_ctl promote -D /data\n```\n\n> Escalate **fast**.',
    );

    expect(blocks).toEqual([
      { kind: 'code', lines: ['pg_ctl promote -D /data'], lang: 'bash' },
      {
        kind: 'quote',
        blocks: [{
          kind: 'paragraph',
          runs: [{ text: 'Escalate ' }, { text: 'fast', bold: true }, { text: '.' }],
        }],
      },
    ]);
  });

  describe('fence info strings', () => {
    const langOf = (opener: string) => {
      const [block] = parseMarkdownBlocks(`${opener}\nbody\n\`\`\``);
      return block?.kind === 'code' ? block.lang : 'NOT-A-CODE-BLOCK';
    };

    it('keeps the token verbatim rather than normalising it', () => {
      // Normalising here is what made the export disagree with the app:
      // folding `MerMaid` to `mermaid` captioned a block the renderers
      // treat as ordinary code. Stored raw, compared with the shared
      // rule.
      expect(langOf('```MerMaid')).toBe('MerMaid');
      expect(codeCaption(langOf('```MerMaid'))).toBeNull();
    });

    it('keeps only the first word — which is what remark does too', () => {
      // ```` ```mermaid title="x" ```` yields class `language-mermaid`
      // in react-markdown, so both surfaces agree this IS a diagram.
      expect(langOf('```mermaid title="x"')).toBe('mermaid');
      expect(codeCaption(langOf('```mermaid title="x"'))).toBe(
        'Diagram — mermaid',
      );
    });

    it('reads a tilde fence too', () => {
      const [block] = parseMarkdownBlocks('~~~mermaid\nbody\n~~~');
      expect(block).toEqual({ kind: 'code', lines: ['body'], lang: 'mermaid' });
    });

    it('omits the key entirely for a bare fence', () => {
      expect(parseMarkdownBlocks('```\nbody\n```')).toEqual([
        { kind: 'code', lines: ['body'] },
      ]);
    });

    it('never captions a language that is not exactly mermaid', () => {
      for (const opener of ['```' + 'a'.repeat(200), '```!!!', '```bash']) {
        expect(codeCaption(langOf(opener))).toBeNull();
      }
    });

    it('does not treat a backtick-bearing info string as a fence at all', () => {
      // CommonMark: a backtick fence's info string may not contain a
      // backtick, so react-markdown renders this line as a paragraph.
      const blocks = parseMarkdownBlocks('```m`ermaid\nbody\n```');
      expect(blocks.some((b) => b.kind === 'code' && b.lang === 'mermaid')).toBe(
        false,
      );
    });

    it('allows a backtick in a TILDE fence but still does not call it mermaid', () => {
      // CommonMark permits it, so this IS a fence — but react-markdown
      // gives it class `language-m\`ermaid`, which the app does not
      // route. Stripping the backtick here would have INVENTED agreement
      // that does not exist.
      const [block] = parseMarkdownBlocks('~~~m`ermaid\nbody\n~~~');
      expect(block).toEqual({ kind: 'code', lines: ['body'], lang: 'm`ermaid' });
      expect(codeCaption('m`ermaid')).toBeNull();
    });
  });

  describe('cross-surface agreement', () => {
    // The property that matters: the PDF must caption a fence if and
    // only if the React renderers would draw it. Both now read the same
    // rule from @weavestream/shared, so this compares the PDF's decision
    // against that rule applied to the class react-markdown builds.
    const appWouldRender = (info: string) =>
      isMermaidLanguage(`language-${fenceInfoLanguage(info)}`.slice('language-'.length));

    it.each([
      'mermaid',
      'mermaid title="x"',
      'MerMaid',
      'Mermaid',
      'mermaidjs',
      'bash',
      '',
      '!!!',
    ])('agrees with the app for info string %p', (info) => {
      const pdfCaptions = codeCaption(fenceInfoLanguage(info) || undefined) !== null;
      expect(pdfCaptions).toBe(appWouldRender(info));
    });
  });

  describe('codeCaption', () => {
    it('captions a diagram language', () => {
      expect(codeCaption('mermaid')).toBe('Diagram — mermaid');
    });

    it('leaves ordinary code uncaptioned — bash announces itself', () => {
      expect(codeCaption('bash')).toBeNull();
      expect(codeCaption(undefined)).toBeNull();
    });
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
  itWithPdfTools('renders essential IPAM, topology, procedures, provenance, dates, and safe gaps as text', async () => {
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

  itWithPdfTools('renders explicit empty-state sections', async () => {
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

  itWithPdfTools('omits the reconstruction dossier entirely when Breeze is not active', async () => {
    const pdf = await buildCompanyExportPdf(
      companyPdfTestFixture({ breezeIntegrationActive: false }),
    );
    const text = extractPdfText(pdf);

    // Neither the section banner nor the cover-page contents row.
    expect(text).not.toMatch(/Reconstruction [Dd]ossier/);
    expect(text).not.toMatch(/Synchronized current/i);
    expect(text).not.toContain('Source provenance and age');
    // Every other section still renders.
    expect(text).toContain('Relationships / Topology');
    expect(text).toContain('IP Address Management');
    expect(text).toContain('Monitored Domains');
  });

  itWithPdfTools('starts every article on a fresh page', async () => {
    const base = companyPdfTestFixture();
    const data = companyPdfTestFixture({
      articles: [
        {
          ...base.articles[0]!,
          title: 'First Runbook',
          markdownSource: 'Alpha body.',
          contentPlaintext: null,
        },
        {
          ...base.articles[0]!,
          id: '00000000-0000-4000-8000-000000000042',
          title: 'Second Runbook',
          markdownSource: 'Beta body.',
          contentPlaintext: null,
        },
      ],
    });

    const text = extractPdfText(await buildCompanyExportPdf(data));

    // Both articles easily fit one page — the break is forced, so the
    // second article sits under a slim continuation banner.
    expect(text).toContain('First Runbook');
    expect(text).toContain('Second Runbook');
    expect(text).toContain('Articles (continued)');
    const continuedAt = text.indexOf('Articles (continued)');
    expect(continuedAt).toBeGreaterThan(text.indexOf('Alpha body.'));
    expect(continuedAt).toBeLessThan(text.indexOf('Second Runbook'));
  });

  itWithPdfTools('truncates oversized table headers without stalling the worker', async () => {
    const base = companyPdfTestFixture();
    // Body cells stay small so the table renders as a table and the
    // header actually reaches the ellipsis truncation path.
    const markdownSource = [
      `| ${'H'.repeat(5_000)} | Status |`,
      '| --- | --- |',
      '| ok | fine |',
      '',
      'AFTER-WIDE-TABLE',
    ].join('\n');
    const data = companyPdfTestFixture({
      articles: [{ ...base.articles[0]!, markdownSource, contentPlaintext: null }],
    });

    const started = Date.now();
    const text = extractPdfText(await buildCompanyExportPdf(data));

    // The quadratic drop-one-rescan-all truncation took >30s on this
    // input; the binary search finishes with the whole build in well
    // under this generous bound.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(text).toContain('…');
    expect(text).toContain('Status');
    expect(text).toContain('fine');
    expect(text).toContain('AFTER-WIDE-TABLE');
  });

  itWithPdfTools('degrades page-tall table rows to preformatted text instead of corrupting pagination', async () => {
    const base = companyPdfTestFixture();
    // ~400 words in one cell measures far beyond one page at the
    // two-column cell width — undrawable as a single table row.
    const huge = Array.from({ length: 400 }, (_, index) => `cellword${index}`).join(' ');
    const markdownSource = [
      '# Big Table',
      '',
      '| Key | Value |',
      '| --- | --- |',
      `| big | ${huge} |`,
      '',
      'AFTER-TABLE-PARAGRAPH',
    ].join('\n');
    const data = companyPdfTestFixture({
      articles: [{ ...base.articles[0]!, markdownSource, contentPlaintext: null }],
    });

    const { text, pages } = inspectPdf(await buildCompanyExportPdf(data));

    // Every cell survives (preformatted, not clamped), and the flow
    // after the table stays in order — doc.y was not corrupted.
    expect(text).toContain('cellword0');
    expect(text).toContain('cellword399');
    expect(text).toContain('AFTER-TABLE-PARAGRAPH');
    expect(text.indexOf('AFTER-TABLE-PARAGRAPH'))
      .toBeGreaterThan(text.indexOf('cellword399'));
    expect(pages).toBeGreaterThan(2);
    expect(text).toMatch(/Page \d+ of \d+/);
  });

  itWithPdfTools('renders article markdown structure: numbering, tables, tasks, code, symbols', async () => {
    const base = companyPdfTestFixture();
    const markdownSource = [
      '# Failover Runbook',
      '',
      'Promote the standby, then verify replication → lag stays low.',
      '',
      '1. Stop application traffic.',
      '2. Promote the standby database.',
      '3. Update DNS records.',
      '',
      '- [x] Snapshot taken',
      '- [ ] Stakeholders notified',
      '',
      '| Host | Role | VLAN |',
      '| --- | --- | --- |',
      '| db-01 | primary | 30 |',
      '| db-02 | standby \\| reserve | 40 |',
      '',
      '```bash',
      'pg_ctl promote -D /var/lib/postgres',
      '```',
      '',
      '> Escalate to on-call if replication stalls.',
    ].join('\n');
    const data = companyPdfTestFixture({
      articles: [{ ...base.articles[0]!, markdownSource, contentPlaintext: null }],
    });

    const text = extractPdfText(await buildCompanyExportPdf(data));

    expect(text).toContain('Failover Runbook');
    // Ordered lists keep their numbering.
    expect(text).toContain('3.');
    expect(text).toContain('Update DNS records.');
    // Task items draw vector checkboxes — no "[x]" marker artifacts.
    expect(text).toContain('Snapshot taken');
    expect(text).toContain('Stakeholders notified');
    expect(text).not.toContain('[x]');
    expect(text).not.toContain('- [ ]');
    // Table cells survive, including escaped pipes.
    expect(text).toContain('VLAN');
    expect(text).toContain('db-01');
    expect(text).toContain('standby | reserve');
    // Fenced code keeps its content, sheds its fences.
    expect(text).toContain('pg_ctl promote -D /var/lib/postgres');
    expect(text).not.toContain('```');
    // Arrows are packaged glyphs — literal, never [U+2192] markers.
    expect(text).toContain('→');
    expect(text).not.toContain('[U+2192]');
    expect(text).toContain('Escalate to on-call if replication stalls.');
    // A bash fence gets NO caption: it announces itself, and a label on
    // every code block would be chrome for zero information.
    expect(text).not.toContain('Diagram —');
  });

  itWithPdfTools('captions a mermaid fence and keeps its source', async () => {
    const base = companyPdfTestFixture();
    const markdownSource = [
      '# Failover',
      '',
      '```mermaid',
      'flowchart TD',
      '  P[Primary] --> R[Replica]',
      '```',
    ].join('\n');
    const data = companyPdfTestFixture({
      articles: [{ ...base.articles[0]!, markdownSource, contentPlaintext: null }],
    });

    const text = extractPdfText(await buildCompanyExportPdf(data));

    // The export does not rasterize diagrams, so the caption is what
    // tells a reader this block is a diagram rather than broken output.
    expect(text).toContain('Diagram — mermaid');
    // ...and the source is still there to be read.
    expect(text).toContain('flowchart TD');
    // Node brackets survive as `[[` — CR-020's reversible display
    // encoding doubles `[` so the `[U+XXXX]` marker syntax stays
    // unambiguous. That applies to every code block (a bash command with
    // a `[` reads the same way) and is not specific to diagrams; assert
    // the content rather than the punctuation.
    expect(text).toContain('Primary');
    expect(text).toContain('Replica');
    expect(text).not.toContain('```');
  });

  itWithPdfTools('captions a mermaid fence authored in a Tiptap article', async () => {
    // The Tiptap projection (`tiptapDocToMarkdown`) emits the fence
    // language, so this path gets the caption for free — but only if the
    // language survives that walker's own sanitisation.
    const base = companyPdfTestFixture();
    const data = companyPdfTestFixture({
      articles: [{
        ...base.articles[0]!,
        editorMode: 'tiptap',
        markdownSource: null,
        contentPlaintext: null,
        content: {
          type: 'doc',
          content: [{
            type: 'codeBlock',
            attrs: { language: 'mermaid' },
            content: [{ type: 'text', text: 'flowchart TD\n  A --> B' }],
          }],
        },
      }],
    });

    const text = extractPdfText(await buildCompanyExportPdf(data));

    expect(text).toContain('Diagram — mermaid');
    expect(text).toContain('flowchart TD');
  });

  itWithPdfTools('paginates long tables and wraps long safe messages with continuation context', async () => {
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

  itWithPdfTools('preserves existing plaintext-password and article-image fallback behavior', async () => {
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

  itWithPdfTools('embeds deterministic Unicode fonts and applies the explicit emoji fallback', async () => {
    const base = companyPdfTestFixture();
    const data: CompanyExportData = {
      ...base,
      company: { ...base.company, name: '東京復旧 株式会社 Пример восстановления 😀' },
      articles: [{
        ...base.articles[0]!,
        title: '復旧手順 — Процедура',
        markdownSource: 'サーバーを復元します。 Проверить сеть. 😀',
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

  itWithPdfTools('normalizes exotic prose spaces to plain space while credentials stay flagged', async () => {
    const base = companyPdfTestFixture();
    const data: CompanyExportData = {
      ...base,
      includePasswords: true,
      articles: [{
        ...base.articles[0]!,
        title: 'Why Organizations Choose Rocky Linux\u202F9',
        markdownSource: 'Version\u00A09 ships\u2009fast.',
        contentPlaintext: null,
      }],
      passwords: [{
        ...base.passwords[0]!,
        password: 'secret\u202Fwith-nnbsp',
        totpSecret: 'OTP\u00A0SECRET',
        notes: null,
      }],
    };

    const text = extractPdfText(await buildCompanyExportPdf(data));

    // Prose: NBSP/NNBSP/thin space collapse to plain space — words stay
    // joined by a real space instead of "[U+202F]" marker noise.
    expect(text).toContain('Why Organizations Choose Rocky Linux 9');
    expect(text).toContain('Version 9 ships fast.');
    expect(text).not.toContain('Rocky Linux[U+202F]9');
    expect(text).not.toContain('Version[U+00A0]9');
    expect(text).not.toContain('ships[U+2009]fast');

    // Credentials never take the normalization path (CR-020): the same
    // separators stay byte-exact-or-flagged with the explicit note.
    expect(text).toContain('secret[U+202F]with-nnbsp');
    expect(text).toContain('OTP[U+00A0]SECRET');
    expect(text.match(/Not literal/g) ?? []).toHaveLength(2);

    // U+3000 is intentional CJK typography and provably renderable.
    expect(pdfSafeUserText('全角\u3000スペース')).toBe('全角\u3000スペース');
  });

  itWithPdfTools('flags unrenderable credentials explicitly and encodes prose deterministically', async () => {
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
      articles: [{ ...base.articles[0]!, markdownSource: `Devanagari ${devanagari}` }],
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

  itWithPdfTools('renders literal-notation credentials byte-exact and flags encoded ones apart', async () => {
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

  itWithPdfTools('renders packaged-font credentials byte-exact without escape notation', async () => {
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

  itWithPdfTools('encodes control and formatting characters in credentials instead of normalizing them', async () => {
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

  itWithPdfTools('rejects default-ignorable and unassigned code points from the literal credential path', async () => {
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

  itWithPdfTools('rejects range-approved code points the packaged fonts cannot actually draw', async () => {
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

  itWithPdfTools('parses serialized rich-text notes and fields before display encoding', async () => {
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

  itWithPdfTools('encrypts password-protected exports with AES-256 and requires the password', async () => {
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

  itWithPdfTools('sanitizes XML-special company names out of metadata but not page content', async () => {
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

  itWithPdfTools('labels stale-bound records unmistakably as last-known stale', async () => {
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
    expect(text).toContain('Stale since Jul 14, 2026');
  });

  itWithPdfTools('keeps UTC dates and the PDF hash invariant across process timezones', async () => {
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
      // Dates are evaluated on the UTC calendar regardless of process
      // timezone — in Denver local time this instant is still Jul 13,
      // and the byte-identical hashes above prove nothing shifted.
      expect(extractPdfText(utc)).toContain('Jul 14, 2026');
      expect(extractPdfText(denver)).toContain('Jul 14, 2026');
    } finally {
      if (originalTimezone === undefined) delete process.env['TZ'];
      else process.env['TZ'] = originalTimezone;
    }
  });

  itWithPdfTools('paginates maximum-size gap headings, messages, and footers as measured cards', async () => {
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

  itWithPdfTools('removes only its empty scoped Poppler inspection directories', async () => {
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
      // Wide badge text — exercises the measured right-aligned pill.
      pwnedCount: 52_256_179,
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
      markdownSource: `${article.markdownSource ?? ''}\n\nサーバーを復元します。 Проверить сеть. 😀 1️⃣ 🇺🇸\nLiteral brackets [restore] and marker [U+1F600].\nDevanagari नमस्ते · Thai สวัสดี\n\n| Interface → | VLAN |\n| --- | --- |\n| eth0 → trunk | 30 |\n\n- [x] Failover tested\n- [ ] Runbook reviewed`,
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
