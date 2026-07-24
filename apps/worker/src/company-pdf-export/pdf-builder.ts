import PDFDocument from 'pdfkit';
import { create as parseFontCmap } from 'fontkit';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  MAX_IMAGE_DECODE_PIXELS,
  tiptapDocToMarkdown,
  tiptapToPlaintext,
} from '@weavestream/shared';
import type { CompanyExportData } from '../../../api/src/exports/company-export-data.service.js';

interface PdfBuildOpts {
  pdfPassword?: string;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const FONT_NORMAL = 'NotoSansCJK';
const FONT_BOLD = 'NotoSansCJKBold';
const FONT_NORMAL_PATH = resolve(__dirname, 'fonts/NotoSansCJKjp-Regular.otf');
const FONT_BOLD_PATH = resolve(__dirname, 'fonts/NotoSansCJKjp-Bold.otf');

// One read serves both consumers: the cmaps the packaged-code-point gate
// consults and the bytes PDFKit embeds are the same buffers, so glyph
// coverage checks can never diverge from what actually renders.
const FONT_NORMAL_DATA = readFileSync(FONT_NORMAL_PATH);
const FONT_BOLD_DATA = readFileSync(FONT_BOLD_PATH);
const PACKAGED_FONT_CMAPS = [
  parseFontCmap(FONT_NORMAL_DATA),
  parseFontCmap(FONT_BOLD_DATA),
];

/**
 * Cap-height ratio of the packaged fonts (identical for regular/bold:
 * 733/1000). PDFKit anchors `text(x, y)` at the top of the line box and
 * the CJK fonts carry a 1.16em ascender, so top-anchored text inside a
 * fixed-height box lands visibly below center. Boxed text (banners,
 * table header pills, badges) is therefore drawn with
 * `baseline: 'alphabetic'` at a baseline computed from the cap height,
 * which is font-independent by construction.
 */
const CAP_HEIGHT_RATIO = Math.max(
  ...PACKAGED_FONT_CMAPS.map((font) => font.capHeight / font.unitsPerEm),
);

/**
 * Baseline that vertically centers a run of capital-height text inside
 * a box drawn from `boxTop` with height `boxHeight`.
 */
function capCenteredBaseline(
  boxTop: number,
  boxHeight: number,
  fontSize: number,
): number {
  return boxTop + (boxHeight + CAP_HEIGHT_RATIO * fontSize) / 2;
}

const PAGE_WIDTH = 612; // letter
const PAGE_HEIGHT = 792;
const MARGIN_X = 54;
const MARGIN_TOP = 54;
const FOOTER_HEIGHT = 32;
const MARGIN_BOTTOM = 32 + FOOTER_HEIGHT;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

/** Section banner that opens every non-cover page. */
const BANNER_HEIGHT = 64;
/** Y at which content begins on a section page (below the banner). */
const BANNER_CONTENT_Y = BANNER_HEIGHT + 22;

const ROW_HEIGHT = 18;
/** Maximum chars we render for any single asset *field value* (notes can blow up). */
const ASSET_VALUE_MAX_CHARS = 6000;

// Modern, calm palette. Indigo accent + neutral grays. Printable on
// monochrome devices (every color value also reads as a distinct gray).
const C = {
  ink: '#0f172a', // primary text
  ink2: '#334155', // secondary text
  ink3: '#64748b', // muted / labels
  ink4: '#94a3b8', // very muted
  rule: '#e2e8f0',
  ruleSoft: '#f1f5f9',
  banner: '#1e293b',
  bannerAccent: '#6366f1',
  badge: '#eef2ff',
  cardBg: '#f8fafc',
  cardBorder: '#e2e8f0',
  cardAccent: '#6366f1',
  ok: '#15803d',
  okBg: '#dcfce7',
  warn: '#b45309',
  warnBg: '#fef3c7',
  danger: '#b91c1c',
  dangerBg: '#fee2e2',
  white: '#ffffff',
  zebra: '#f8fafc',
};

type ExportAssetField = CompanyExportData['assets'][number]['fields'][number];
type ExportArticle = CompanyExportData['articles'][number];

const ARTICLE_IMAGE_RE =
  /\/api\/v1\/companies\/[0-9a-f-]{36}\/uploads\/([0-9a-f-]{36})/i;

// ---------------------------------------------------------------------------
// Article markdown model
// ---------------------------------------------------------------------------
// Articles render from one common representation: markdown. Tiptap
// documents are projected through the shared `tiptapDocToMarkdown`
// walker; markdown-mode articles use their source directly. The blocks
// below are what the layout engine draws — a deliberate GFM subset
// (the article editor's own node set), parsed line-by-line with no
// dependency on a markdown engine.

export interface MarkdownInlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  link?: boolean;
}

export interface MarkdownListItem {
  /** Rendered marker: '•' for bullets, '3.' for ordered items. */
  marker: string;
  /** Task-list state; null for plain list items. */
  task: 'checked' | 'unchecked' | null;
  runs: MarkdownInlineRun[];
  /** Nested blocks (sub-lists, continuation paragraphs). */
  children: MarkdownBlock[];
}

export type MarkdownBlock =
  | { kind: 'heading'; level: number; runs: MarkdownInlineRun[] }
  | { kind: 'paragraph'; runs: MarkdownInlineRun[] }
  | { kind: 'list'; items: MarkdownListItem[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'quote'; blocks: MarkdownBlock[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'image'; uploadId: string | null; label: string | null };

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function buildCompanyExportPdf(
  data: CompanyExportData,
  opts: PdfBuildOpts = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: {
        top: MARGIN_TOP,
        bottom: MARGIN_BOTTOM,
        left: MARGIN_X,
        right: MARGIN_X,
      },
      // Required so the footer/page-number sweep below can re-enter
      // already-emitted pages via switchToPage().
      bufferPages: true,
      info: {
        Title: pdfMetadataTitle(data.company.name),
        Author: 'Weavestream',
        CreationDate: data.exportedAt,
      },
      // PDFKit's `userPassword` opens the document; `ownerPassword`
      // controls printing/copying. We set them to the same value so a
      // single shared secret unlocks everything.
      //
      // `pdfVersion: '1.7ext3'` selects PDFKit's strongest handler:
      // AES-256 (V=5/R=5, AESV3 crypt filter, Adobe Extension Level 3).
      // CBC mode is fixed by the PDF standard — conforming readers accept
      // no other AES mode, so the AES-256-GCM house rule cannot apply to
      // in-file PDF encryption. Scoped to the password branch so
      // unencrypted exports keep the byte-stable PDF 1.3 output; the XMP
      // packet PDF >= 1.4 emits carries the Title, which is why the
      // metadata title is XML-sanitized (see pdfMetadataTitle).
      // Explicit permissions keep text copy available to readers that
      // authenticate the shared secret as the *user* password —
      // credentials in a vault archive must stay copyable.
      ...(opts.pdfPassword
        ? {
            pdfVersion: '1.7ext3' as const,
            userPassword: opts.pdfPassword,
            ownerPassword: opts.pdfPassword,
            permissions: {
              printing: 'highResolution' as const,
              copying: true,
              contentAccessibility: true,
            },
          }
        : {}),
    });
    doc.registerFont(FONT_NORMAL, FONT_NORMAL_DATA);
    doc.registerFont(FONT_BOLD, FONT_BOLD_DATA);

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      renderCover(doc, data);

      renderCompanyDetails(doc, data);
      renderMembers(doc, data);

      if (data.assets.length > 0) renderAssets(doc, data);
      renderPasswords(doc, data);
      if (data.articles.length > 0) renderArticles(doc, data);
      renderIpam(doc, data);
      renderRelationships(doc, data);
      // The reconstruction dossier documents Breeze-synchronized state;
      // without an active Breeze integration for this company the
      // section (and its cover-page row) is meaningless noise.
      if (data.breezeIntegrationActive) renderReconstruction(doc, data);
      renderDomains(doc, data);
      if (data.uploads.length > 0) renderUploads(doc, data);

      // Stamp page numbers / running footer AFTER content is laid out
      // but BEFORE end(). PDFKit finalises buffered pages on .end() and
      // any later mutation is silently dropped.
      decorateFooters(doc, data);
      doc.end();
    } catch (err) {
      reject(err as Error);
    }
  });
}

/**
 * Document-metadata title. The string reaches two sinks: the Info
 * dictionary (accepts any text) and — for PDF >= 1.4, i.e. every
 * encrypted export — an XMP packet that PDFKit interpolates WITHOUT XML
 * escaping. Escaping here would display entities in the Info title, so
 * strip instead; the company name renders untouched in the page content
 * either way. Two filters: characters outside XML 1.0's Char production
 * (#x9|#xA|#xD|[#x20-#xD7FF]|[#xE000-#xFFFD]|[#x10000-#x10FFFF] — so
 * U+FFFE/U+FFFF, lone surrogates, raw C0), then the XML-special
 * characters, controls/format characters, and the supplementary-plane
 * noncharacters XML technically permits.
 */
function pdfMetadataTitle(companyName: string): string {
  const safe = companyName
    .replace(/[^\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, ' ')
    .replace(/[&<>\p{Cc}\p{Cf}\p{Noncharacter_Code_Point}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return safe ? `Vault Export - ${safe}` : 'Vault Export';
}

// ---------------------------------------------------------------------------
// Page primitives
// ---------------------------------------------------------------------------

/** First Y at which `tableRow` / `ensureRoom` can still write. */
function pageBottomBoundary(): number {
  return PAGE_HEIGHT - MARGIN_BOTTOM;
}

/**
 * If there's not enough vertical room for `needed` more pixels, add a
 * page and (if we're inside a section) re-draw a slim section banner so
 * continuation pages don't lose their context. Returns true if a page
 * break occurred.
 */
function ensureRoom(
  doc: PDFKit.PDFDocument,
  needed: number,
  continuationTitle?: string,
): boolean {
  if (doc.y + needed <= pageBottomBoundary()) return false;
  doc.addPage();
  if (continuationTitle) drawSlimBanner(doc, continuationTitle);
  return true;
}

/**
 * Writes a section page. Adds a fresh page, paints a colored banner at
 * the top, sets the cursor to BANNER_CONTENT_Y. Subsequent renderers
 * begin drawing immediately at `doc.y`.
 */
function sectionBanner(
  doc: PDFKit.PDFDocument,
  title: string,
  subtitle?: string,
): void {
  doc.addPage();
  paintBanner(doc, title, subtitle);
  doc.x = MARGIN_X;
  doc.y = BANNER_CONTENT_Y;
}

function paintBanner(
  doc: PDFKit.PDFDocument,
  title: string,
  subtitle?: string,
): void {
  doc.save();
  doc.rect(0, 0, PAGE_WIDTH, BANNER_HEIGHT).fill(C.banner);
  // Accent stripe along the bottom of the banner.
  doc.rect(0, BANNER_HEIGHT, PAGE_WIDTH, 3).fill(C.bannerAccent);
  // Baseline-anchored so the CJK fonts' tall ascender cannot push the
  // text into the accent stripe: title caps start ~22 from the top,
  // the subtitle clears the stripe by its descender plus 7px.
  doc.fillColor(C.white)
    .font(FONT_BOLD).fontSize(20)
    .text(title, MARGIN_X, 22 + CAP_HEIGHT_RATIO * 20, {
      width: CONTENT_WIDTH,
      lineBreak: false,
      baseline: 'alphabetic',
    });
  if (subtitle) {
    doc.fillColor('#cbd5e1')
      .font(FONT_NORMAL).fontSize(10)
      .text(pdfSafeUserText(subtitle), MARGIN_X, BANNER_HEIGHT - 10, {
        width: CONTENT_WIDTH,
        lineBreak: false,
        baseline: 'alphabetic',
      });
  }
  doc.restore();
}

function drawSlimBanner(doc: PDFKit.PDFDocument, title: string): void {
  doc.save();
  doc.rect(0, 0, PAGE_WIDTH, 28).fill(C.banner);
  doc.fillColor(C.white)
    .font(FONT_BOLD).fontSize(11)
    .text(`${title} (continued)`, MARGIN_X, capCenteredBaseline(0, 28, 11), {
      width: CONTENT_WIDTH,
      lineBreak: false,
      baseline: 'alphabetic',
    });
  doc.restore();
  doc.x = MARGIN_X;
  doc.y = 44;
}

// ---------------------------------------------------------------------------
// Form field primitives (label + value)
// ---------------------------------------------------------------------------

/** Single full-width label/value field. Hides only on null/undefined/''. */
function field(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string | null | undefined,
  sectionTitle?: string,
): void {
  if (value === null || value === undefined || value === '') return;
  drawLabeledValue(doc, label, pdfSafeUserText(value), sectionTitle);
}

const CREDENTIAL_ENCODING_NOTE =
  'Not literal - contains characters the PDF cannot reproduce exactly ' +
  '(missing from the packaged fonts, or normalized by PDF text layout). ' +
  'To recover the value, decode each "[U+hex]" marker to its code points ' +
  'and read "[[" as a literal "[".';

/**
 * Credential values must survive copy/paste byte-exact (CR-020). When
 * every grapheme both renders in the packaged fonts and survives text
 * extraction unchanged, the value is drawn verbatim — no bracket
 * doubling, no substitution. Otherwise we refuse to print a
 * silently-mutated string: a warning names the encoding, then the
 * reversible [U+hex] form follows so a recovery operator still has the
 * bytes. The warning's presence is what distinguishes an encoded value
 * from a credential that literally contains [U+...] notation.
 */
function credentialField(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string | null | undefined,
  sectionTitle?: string,
): void {
  if (value === null || value === undefined || value === '') return;
  if (isCredentialLiteralText(value)) {
    drawLabeledValue(doc, label, value, sectionTitle);
    return;
  }
  ensureRoom(doc, 46, sectionTitle);
  doc.font(FONT_BOLD).fontSize(8).fillColor(C.ink3)
    .text(label.toUpperCase(), MARGIN_X, doc.y, {
      width: CONTENT_WIDTH,
      characterSpacing: 0.4,
    });
  doc.font(FONT_NORMAL).fontSize(8).fillColor(C.warn)
    .text(CREDENTIAL_ENCODING_NOTE, MARGIN_X, doc.y, { width: CONTENT_WIDTH });
  doc.font(FONT_NORMAL).fontSize(10.5).fillColor(C.ink)
    .text(pdfSafeCredentialText(value), MARGIN_X, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.45);
}

function drawLabeledValue(
  doc: PDFKit.PDFDocument,
  label: string,
  displayValue: string,
  sectionTitle?: string,
): void {
  ensureRoom(doc, 30, sectionTitle);
  doc.font(FONT_BOLD).fontSize(8).fillColor(C.ink3)
    .text(label.toUpperCase(), MARGIN_X, doc.y, {
      width: CONTENT_WIDTH,
      characterSpacing: 0.4,
    });
  doc.font(FONT_NORMAL).fontSize(10.5).fillColor(C.ink)
    .text(displayValue, MARGIN_X, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.45);
}

/**
 * Two-column field grid. Caller passes pairs of [label, value]; we lay
 * them out in rows of two columns. Useful for compact metadata blocks
 * like company contact info.
 */
function fieldGrid(
  doc: PDFKit.PDFDocument,
  pairs: Array<[string, string | null | undefined]>,
  sectionTitle?: string,
): void {
  const present = presentDisplayPairs(pairs);
  if (present.length === 0) return;

  const colWidth = (CONTENT_WIDTH - 16) / 2;
  for (let i = 0; i < present.length; i += 2) {
    const left = present[i]!;
    const right = present[i + 1];
    ensureRoom(doc, 36, sectionTitle);
    const startY = doc.y;

    const leftEnd = drawFieldCell(doc, left[0], left[1], MARGIN_X, startY, colWidth);
    let rightEnd = leftEnd;
    if (right) {
      rightEnd = drawFieldCell(
        doc,
        right[0],
        right[1],
        MARGIN_X + colWidth + 16,
        startY,
        colWidth,
      );
    }
    // Advance to whichever column ended deeper so the next row clears
    // both halves.
    doc.y = Math.max(leftEnd, rightEnd);
    doc.moveDown(0.3);
  }
}

function measureFieldGrid(
  doc: PDFKit.PDFDocument,
  pairs: Array<[string, string | null | undefined]>,
): number {
  const present = presentDisplayPairs(pairs);
  const colWidth = (CONTENT_WIDTH - 16) / 2;
  let height = 0;
  for (let index = 0; index < present.length; index += 2) {
    const row = present.slice(index, index + 2);
    doc.font(FONT_BOLD).fontSize(8);
    const labelHeight = Math.max(...row.map(([label]) =>
      doc.heightOfString(label.toUpperCase(), { width: colWidth }),
    ));
    doc.font(FONT_NORMAL).fontSize(10.5);
    const valueHeight = Math.max(...row.map(([, value]) =>
      doc.heightOfString(value, { width: colWidth }),
    ));
    height += labelHeight + valueHeight + doc.currentLineHeight() * 0.3;
  }
  return height;
}

/**
 * Shared by fieldGrid and measureFieldGrid so the measured strings are
 * exactly the drawn strings: same presence filter, same display encoding.
 */
function presentDisplayPairs(
  pairs: Array<[string, string | null | undefined]>,
): Array<[string, string]> {
  return pairs
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value]) => [label, pdfSafeUserText(value as string)]);
}

function drawFieldCell(
  doc: PDFKit.PDFDocument,
  label: string,
  value: string,
  x: number,
  y: number,
  width: number,
): number {
  doc.font(FONT_BOLD).fontSize(8).fillColor(C.ink3)
    .text(label.toUpperCase(), x, y, { width, characterSpacing: 0.4 });
  const valueY = doc.y;
  doc.font(FONT_NORMAL).fontSize(10.5).fillColor(C.ink)
    .text(value, x, valueY, { width });
  return doc.y;
}

function subheading(doc: PDFKit.PDFDocument, text: string, sectionTitle?: string): void {
  ensureRoom(doc, 38, sectionTitle);
  doc.moveDown(0.6);
  doc.font(FONT_BOLD).fontSize(11).fillColor(C.ink2)
    .text(pdfSafeUserText(text), MARGIN_X, doc.y, { width: CONTENT_WIDTH });
  doc.moveDown(0.15);
  // Tiny accent rule to anchor the heading.
  const y = doc.y;
  doc.save();
  doc.strokeColor(C.bannerAccent).lineWidth(1.5)
    .moveTo(MARGIN_X, y).lineTo(MARGIN_X + 24, y).stroke();
  doc.restore();
  doc.moveDown(0.5);
}

// ---------------------------------------------------------------------------
// Tables (with auto-pagination + cell ellipsis)
// ---------------------------------------------------------------------------

interface TableSpec {
  title: string; // section title (used for slim continuation banner)
  headers: string[];
  /** Pixel widths. Caller MUST ensure sum <= CONTENT_WIDTH. */
  widths: number[];
  /** Per-column horizontal alignment. */
  aligns?: ('left' | 'right')[];
  /** Left edge; defaults to the page margin. */
  x?: number;
}

function tableOrigin(table: TableSpec): { left: number; width: number } {
  return {
    left: table.x ?? MARGIN_X,
    width: table.widths.reduce((total, width) => total + width, 0),
  };
}

function drawTableHeaderRow(doc: PDFKit.PDFDocument, table: TableSpec): void {
  const headerY = doc.y;
  const { left, width } = tableOrigin(table);
  // Header background pill.
  doc.save();
  doc.rect(left, headerY - 4, width, ROW_HEIGHT).fill(C.banner);
  doc.fillColor(C.white).font(FONT_BOLD).fontSize(9);
  const baseline = capCenteredBaseline(headerY - 4, ROW_HEIGHT, 9);
  let x = left + 6;
  table.headers.forEach((h, i) => {
    const w = table.widths[i]! - 12;
    const align = table.aligns?.[i] ?? 'left';
    doc.text(fitText(doc, h, w, FONT_BOLD, 9), x, baseline, {
      width: w,
      lineBreak: false,
      align,
      baseline: 'alphabetic',
    });
    x += table.widths[i]!;
  });
  doc.restore();
  doc.y = headerY + ROW_HEIGHT;
}

function tableRow(
  doc: PDFKit.PDFDocument,
  cols: string[],
  table: TableSpec,
  rowIndex: number,
  colorOverrides: Record<number, string> = {},
): void {
  cols = cols.map((col) => pdfSafeUserText(col));
  const { left, width } = tableOrigin(table);
  if (doc.y + ROW_HEIGHT > pageBottomBoundary()) {
    doc.addPage();
    drawSlimBanner(doc, table.title);
    drawTableHeaderRow(doc, table);
  }

  const rowY = doc.y;
  // Zebra striping
  if (rowIndex % 2 === 1) {
    doc.save();
    doc.rect(left, rowY - 2, width, ROW_HEIGHT).fill(C.zebra);
    doc.restore();
  }

  let x = left + 6;
  cols.forEach((col, i) => {
    const cellW = table.widths[i]! - 12;
    const align = table.aligns?.[i] ?? 'left';
    const color = colorOverrides[i] ?? C.ink;
    doc.font(FONT_NORMAL).fontSize(9).fillColor(color);
    const fitted = fitText(doc, col, cellW, FONT_NORMAL, 9);
    doc.text(fitted, x, rowY + 4, { width: cellW, lineBreak: false, align });
    x += table.widths[i]!;
  });
  doc.y = rowY + ROW_HEIGHT;
}

/**
 * Tallest row `wrappedTableRow` can draw intact: the content area of a
 * continuation page (slim banner content starts at 44, the header row
 * is re-drawn) minus row paddings. A taller row survives its single
 * page break and PDFKit then auto-paginates each CELL independently —
 * columns land on different pages and `doc.y` ends up wherever the
 * last cell's overflow finished.
 */
const MAX_WRAPPED_ROW_HEIGHT =
  PAGE_HEIGHT - MARGIN_BOTTOM - 44 - ROW_HEIGHT - 24;

/**
 * Row-box height for already-display-encoded cells. Shared by the draw
 * path and the markdown table renderer's degrade decision so the two
 * can never measure differently.
 */
function encodedWrappedRowHeight(
  doc: PDFKit.PDFDocument,
  encodedCols: string[],
  table: TableSpec,
): number {
  doc.font(FONT_NORMAL).fontSize(8.5);
  const cellHeights = encodedCols.map((col, index) =>
    doc.heightOfString(col, { width: table.widths[index]! - 12 }),
  );
  return Math.max(ROW_HEIGHT, ...cellHeights.map((height) => height + 10));
}

function wrappedTableRow(
  doc: PDFKit.PDFDocument,
  cols: string[],
  table: TableSpec,
  rowIndex: number,
): void {
  cols = cols.map((col) => pdfSafeUserText(col));
  const { left, width } = tableOrigin(table);
  const measured = encodedWrappedRowHeight(doc, cols, table);
  // Backstop only — every caller keeps cells bounded (the markdown
  // renderer degrades page-tall tables to preformatted text first).
  // Clamping with an explicit per-cell ellipsis beats the alternative:
  // unclamped overflow makes PDFKit paginate cells independently.
  const clamped = measured > MAX_WRAPPED_ROW_HEIGHT;
  const rowHeight = clamped ? MAX_WRAPPED_ROW_HEIGHT : measured;
  if (doc.y + rowHeight > pageBottomBoundary()) {
    doc.addPage();
    drawSlimBanner(doc, table.title);
    drawTableHeaderRow(doc, table);
  }

  const rowY = doc.y;
  if (rowIndex % 2 === 1) {
    doc.save();
    doc.rect(left, rowY - 2, width, rowHeight).fill(C.zebra);
    doc.restore();
  }
  let x = left + 6;
  cols.forEach((col, index) => {
    const cellWidth = table.widths[index]! - 12;
    doc.font(FONT_NORMAL).fontSize(8.5).fillColor(C.ink)
      .text(col, x, rowY + 4, {
        width: cellWidth,
        align: table.aligns?.[index] ?? 'left',
        ...(clamped ? { height: rowHeight - 10, ellipsis: true } : {}),
      });
    x += table.widths[index]!;
  });
  doc.y = rowY + rowHeight;
}

/**
 * More graphemes than any drawable cell can show: the widest cell
 * (CONTENT_WIDTH) over the narrowest visible advance at the smallest
 * table size is ~320 glyphs; the margin absorbs zero-advance combining
 * marks. Text beyond the cap cannot move the ellipsis cut, so it is
 * never measured — article table headers are user content and a single
 * header line can be hundreds of kilobytes.
 */
const FIT_TEXT_MAX_GRAPHEMES = 2000;

/**
 * Pixel ellipsis truncation in O(log n) measurements: binary-search
 * the longest grapheme prefix whose width with '…' still fits. The
 * previous drop-one-rescan-all loop was quadratic — a valid
 * 5,000-character article table header stalled the export worker for
 * over 30 seconds. Grapheme slicing (not code units) keeps combining
 * sequences intact at the cut.
 */
function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  font: string,
  size: number,
): string {
  doc.font(font).fontSize(size);
  const graphemes = [...PDF_GRAPHEME_SEGMENTER.segment(text)]
    .map((entry) => entry.segment);
  const overCap = graphemes.length > FIT_TEXT_MAX_GRAPHEMES;
  if (!overCap && doc.widthOfString(text) <= maxWidth) return text;

  const candidates = overCap
    ? graphemes.slice(0, FIT_TEXT_MAX_GRAPHEMES)
    : graphemes;
  // Over the cap the full candidate prefix may fit (more text exists,
  // so '…' is still truthful); otherwise the text measured too wide
  // and at least one grapheme must go.
  let low = 0;
  let high = overCap ? candidates.length : candidates.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (doc.widthOfString(candidates.slice(0, mid).join('') + '…') <= maxWidth) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return candidates.slice(0, low).join('') + '…';
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

function statusPalette(status: string): { fg: string; bg: string } {
  const s = status.toUpperCase();
  if (s === 'OK') return { fg: C.ok, bg: C.okBg };
  if (s === 'EXPIRING') return { fg: C.warn, bg: C.warnBg };
  if (s === 'EXPIRED' || s === 'FAIL') return { fg: C.danger, bg: C.dangerBg };
  return { fg: C.ink3, bg: C.ruleSoft };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Date-only display. Evaluated in UTC for determinism, but without a
 * "UTC" suffix — a bare date carries no time, so the label was noise
 * that wrapped narrow table columns. Datetime formats (which do show a
 * time) keep the suffix.
 */
function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function humanize(value: string): string {
  return value.replaceAll('_', ' ').replaceAll('-', ' ');
}

function staleRecordLabel(
  state: NonNullable<CompanyExportData['assets'][number]['reconstructionState']>,
): string {
  return `LAST-KNOWN STALE · Stale since ${formatDate(state.staleSince)} · Source ${state.sourceLabel}`;
}

export function formatAssetFieldValue(field: ExportAssetField): string {
  const value = field.value;
  if (value === null || value === undefined || value === '') return '';

  switch (field.fieldType) {
    case 'ASSET_REFERENCE':
    case 'TAGS':
      return listStrings(value)
        .map((id) => field.referenceLabels?.[id] ?? id)
        .join(', ');
    case 'RICH_TEXT':
      return richTextToPlaintext(value);
    case 'BOOLEAN':
      return value ? 'true' : 'false';
    case 'DATE':
    case 'DATETIME':
      return formatStoredDate(value, field.fieldType);
    case 'FILE':
      return formatFileFieldValue(value);
    case 'MULTISELECT':
      return listStrings(value).join(', ');
    default:
      return stringifyFieldValue(value);
  }
}

export function richTextToPlaintext(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string') {
    const parsed = parseJsonIfPossible(value);
    return typeof parsed === 'string' ? parsed : richTextToPlaintext(parsed);
  }
  if (value && typeof value === 'object') {
    const wrapped = value as { plain?: unknown; v?: unknown };
    if (typeof wrapped.plain === 'string') return wrapped.plain;
    if (wrapped.v !== undefined) return richTextToPlaintext(wrapped.v);
  }
  const text = tiptapToPlaintext(value);
  if (text) return text;
  if (isTiptapDocumentLike(value)) return '';
  return stringifyFieldValue(value);
}

function isTiptapDocumentLike(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      ((value as { type?: unknown }).type === 'doc' ||
        'v' in (value as Record<string, unknown>)),
  );
}

function formatStoredDate(value: unknown, fieldType: string): string {
  const raw = typeof value === 'string' ? value : String(value);
  const date = fieldType === 'DATE' && /^\d{4}-\d{2}-\d{2}$/.test(raw)
    ? new Date(`${raw}T00:00:00.000Z`)
    : new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  if (fieldType === 'DATE') return formatDate(date);
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)} UTC`;
}

const PDF_GRAPHEME_SEGMENTER = new Intl.Segmenter('en', { granularity: 'grapheme' });

// Space separators other than plain space and U+3000 (intentional CJK
// typography, provably renderable) collapse to U+0020 in prose display.
// Pasted/AI text glues words to numbers with NBSP/NNBSP/thin space
// (U+00A0, U+202F, U+2009), and ICU ≥72 emits U+202F before AM/PM in
// formatted times — no glyph in the packaged CJK fonts, so they surface
// as "[U+202F]" marker noise. Credentials must NEVER take this path:
// keep the replace in pdfSafeUserText, NOT in shared encodeDisplayText,
// or the password byte-exact-or-flagged guarantee (CR-020) breaks.
const PROSE_SPACE_SEPARATOR_RE = /(?![ \u3000])\p{Zs}/gu;

/**
 * Display-text encoding (CR-020: applied at draw/measure time, never to
 * the export DTO — parsers upstream of rendering must see raw bytes).
 * Graphemes the packaged fonts cover pass through with `[` doubled to
 * `[[`; anything else becomes a reversible `[U+hex]` marker.
 */
export function pdfSafeUserText(value: string): string {
  return encodeDisplayText(
    value.replace(PROSE_SPACE_SEPARATOR_RE, ' '),
    isPackagedPdfGrapheme,
  );
}

/**
 * Credential variant: also encodes characters PDF text layout or
 * extraction rewrites even though they are nominally "packaged" — tabs
 * and newlines collapse to spaces, DEL/C1 have no glyphs, exotic
 * separators extract as plain space, and format characters (soft
 * hyphen, ZWSP, bidi controls) vanish. Prose keeps them raw (notes and
 * articles want real newlines); credential output may not.
 */
function pdfSafeCredentialText(value: string): string {
  return encodeDisplayText(value, isCredentialLiteralGrapheme);
}

function encodeDisplayText(
  value: string,
  isLiteralGrapheme: (segment: string) => boolean,
): string {
  let encoded = '';
  for (const { segment } of PDF_GRAPHEME_SEGMENTER.segment(value)) {
    if (isLiteralGrapheme(segment)) {
      encoded += segment.replaceAll('[', '[[');
      continue;
    }
    encoded += `[U+${[...segment]
      .map((character) => character.codePointAt(0)!)
      .map((codePoint) => codePoint.toString(16).toUpperCase().padStart(4, '0'))
      .join('+')}]`;
  }
  return encoded;
}

/**
 * True when pdfSafeCredentialText would substitute nothing, i.e. the
 * value draws AND text-extracts byte-exact. Bracket doubling is a
 * notation concern, not a renderability one, so `[` counts as literal.
 */
function isCredentialLiteralText(value: string): boolean {
  for (const { segment } of PDF_GRAPHEME_SEGMENTER.segment(value)) {
    if (!isCredentialLiteralGrapheme(segment)) return false;
  }
  return true;
}

function isCredentialLiteralGrapheme(segment: string): boolean {
  return isPackagedPdfGrapheme(segment) &&
    [...segment].every((character) =>
      isExtractionStableCodePoint(character.codePointAt(0)!),
    );
}

function isPackagedPdfGrapheme(segment: string): boolean {
  return [...segment].every((character) =>
    isPackagedPdfCodePoint(character.codePointAt(0)!),
  );
}

/**
 * Fail-closed whitelist — a blocklist here has leaked twice, and a
 * credential must NEVER print mutated. A code point may render
 * literally only when it belongs to a visible-glyph general category
 * (Letter, Mark, Number, Punctuation, Symbol) AND is not
 * default-ignorable: U+034F COMBINING GRAPHEME JOINER is a Mark that
 * extraction drops, and default-ignorables are invisible by definition
 * (the property also covers reserved ranges like U+2065). Everything
 * else — controls, separators, format characters, unassigned code
 * points, surrogates, private use, noncharacters — takes the marked
 * [U+hex] path. Plain space is the one whitelisted separator: it draws
 * a real advance and extracts as itself.
 */
const CREDENTIAL_LITERAL_CATEGORY_RE = /^[\p{L}\p{M}\p{N}\p{P}\p{S}]$/u;
const CREDENTIAL_INVISIBLE_RE = /^\p{Default_Ignorable_Code_Point}$/u;

function isExtractionStableCodePoint(codePoint: number): boolean {
  if (codePoint === 0x20) return true;
  const character = String.fromCodePoint(codePoint);
  return CREDENTIAL_LITERAL_CATEGORY_RE.test(character) &&
    !CREDENTIAL_INVISIBLE_RE.test(character);
}

const PACKAGED_GLYPH_CACHE = new Map<number, boolean>();

/**
 * "Packaged" must be provable, not approximate: a code point qualifies
 * only when it falls in the approved script ranges AND both vendored
 * cmaps carry a real glyph for it. The ranges alone overstate coverage —
 * Noto Sans CJK JP ships no glyph for 1052 range-approved code points
 * (e.g. U+0104 LATIN CAPITAL LETTER A WITH OGONEK), and a missing glyph
 * renders .notdef, which text extraction rewrites. Tab/LF/CR pass for
 * prose flow only (PDFKit converts them to breaks/gaps; no glyph
 * exists); the credential whitelist independently excludes them as Cc.
 */
function isPackagedPdfCodePoint(codePoint: number): boolean {
  if (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d) return true;
  const cached = PACKAGED_GLYPH_CACHE.get(codePoint);
  if (cached !== undefined) return cached;
  const packaged = isApprovedPdfScriptRange(codePoint) &&
    PACKAGED_FONT_CMAPS.every((font) => font.hasGlyphForCodePoint(codePoint));
  PACKAGED_GLYPH_CACHE.set(codePoint, packaged);
  return packaged;
}

/**
 * Script/symbol blocks the export is willing to typeset. This is only
 * the first half of the gate — `isPackagedPdfCodePoint` still requires
 * a real glyph in BOTH vendored cmaps, so widening a range can never
 * print tofu. The symbol blocks (arrows, math operators, technical,
 * enclosed alphanumerics, box drawing, geometric shapes, misc symbols,
 * dingbats) exist because runbook prose routinely contains → ✓ ⚠ ▶ —
 * all carried by Noto Sans CJK — and rendering them as [U+hex] markers
 * read as artifacts.
 */
function isApprovedPdfScriptRange(codePoint: number): boolean {
  return (codePoint >= 0x20 && codePoint <= 0x024f) ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0400 && codePoint <= 0x052f) ||
    (codePoint >= 0x2000 && codePoint <= 0x206f && codePoint !== 0x200d) ||
    (codePoint >= 0x2070 && codePoint <= 0x209f) ||
    (codePoint >= 0x20a0 && codePoint <= 0x20cf) ||
    (codePoint >= 0x2100 && codePoint <= 0x23ff) ||
    (codePoint >= 0x2460 && codePoint <= 0x24ff) ||
    (codePoint >= 0x2500 && codePoint <= 0x27bf) ||
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef);
}

function formatFileFieldValue(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((entry) =>
      entry && typeof entry === 'object'
        ? (entry as { filename?: unknown }).filename
        : null,
    )
    .filter((filename): filename is string => typeof filename === 'string')
    .join(', ');
}

function stringifyFieldValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => stringifyFieldValue(v)).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

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

// ---------------------------------------------------------------------------
// Footer / page number sweep
// ---------------------------------------------------------------------------

/**
 * Stamp `Page X of N` and a CONFIDENTIAL running footer on every page.
 * MUST run before `doc.end()` (PDFKit finalises buffered pages there).
 *
 * The bottom margin is temporarily zeroed during each write — without
 * that, PDFKit treats text drawn beneath the bottom margin as "this
 * doesn't fit" and silently inserts an extra blank page after the one
 * we're trying to decorate. That was doubling page counts in earlier
 * versions of this builder.
 */
function decorateFooters(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const range = doc.bufferedPageRange();
  if (range.count === 0) return;
  const total = range.count;
  const footerLeft = pdfSafeUserText(
    `Confidential · Vault Archive · ${data.company.name}`,
  );
  for (let i = 0; i < total; i++) {
    doc.switchToPage(range.start + i);

    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const y = PAGE_HEIGHT - 28;

    // Thin separator line above the footer.
    doc.save();
    doc.strokeColor(C.rule).lineWidth(0.5)
      .moveTo(MARGIN_X, y - 6)
      .lineTo(MARGIN_X + CONTENT_WIDTH, y - 6)
      .stroke();
    doc.restore();

    doc.font(FONT_NORMAL).fontSize(8).fillColor(C.ink3)
      .text(footerLeft, MARGIN_X, y, {
        width: CONTENT_WIDTH * 0.7,
        lineBreak: false,
      });
    doc.text(
      `Page ${i + 1} of ${total}`,
      MARGIN_X + CONTENT_WIDTH * 0.7,
      y,
      { width: CONTENT_WIDTH * 0.3, align: 'right', lineBreak: false },
    );

    doc.page.margins.bottom = savedBottom;
  }
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderCover(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  // Full-page deep navy with an indigo accent stripe across the middle.
  doc.save();
  doc.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT).fill(C.banner);
  doc.rect(0, 360, PAGE_WIDTH, 4).fill(C.bannerAccent);
  doc.restore();

  doc.fillColor(C.white)
    .font(FONT_BOLD).fontSize(11)
    .text(
      pdfSafeUserText(`${data.workspaceName.toUpperCase()} · CONFIDENTIAL`),
      MARGIN_X,
      96,
      { width: CONTENT_WIDTH, characterSpacing: 1.5 },
    );

  doc.fillColor(C.white)
    .font(FONT_BOLD).fontSize(40)
    .text('Vault Archive', MARGIN_X, 140, { width: CONTENT_WIDTH });

  doc.fillColor('#cbd5e1')
    .font(FONT_NORMAL).fontSize(20)
    .text(pdfSafeUserText(data.company.name), MARGIN_X, 200, { width: CONTENT_WIDTH });

  doc.fillColor('#94a3b8')
    .font(FONT_NORMAL).fontSize(10)
    .text(
      `Exported ${data.exportedAt.toUTCString()}`,
      MARGIN_X,
      244,
      { width: CONTENT_WIDTH },
    );

  const items: Array<[string, string]> = [
    ['Company details', '1 record'],
    [
      'Team members',
      `${data.members.length} ${plural(data.members.length, 'member')}`,
    ],
    [
      'Assets',
      `${data.assets.length} ${plural(data.assets.length, 'asset')}`,
    ],
    [
      'Passwords',
      data.includePasswords
        ? `${data.passwords.length} (plaintext included)`
        : `${data.passwords.length} (metadata only)`,
    ],
    [
      'Articles',
      `${data.articles.length} ${plural(data.articles.length, 'article')}`,
    ],
    [
      'IPAM networks',
      `${data.ipam.length} ${plural(data.ipam.length, 'subnet')}`,
    ],
    [
      'Relationships',
      `${data.relations.length} ${plural(data.relations.length, 'relation')}`,
    ],
    // Mirrors the section gate: no active Breeze integration, no
    // dossier — neither in the body nor on the cover.
    ...(data.breezeIntegrationActive
      ? [[
          'Reconstruction dossier',
          `${data.reconstruction.gaps.length} active ${plural(data.reconstruction.gaps.length, 'gap')}`,
        ] as [string, string]]
      : []),
    [
      'Monitored domains',
      `${data.domains.length} ${plural(data.domains.length, 'domain')}`,
    ],
    [
      'Uploaded files',
      `${data.uploads.length} ${plural(data.uploads.length, 'file')}`,
    ],
  ];

  // Summary card sized to its rows (48px header, 22px per row, 24px
  // bottom padding — 292 at the full ten rows).
  const cardY = 382;
  const cardH = 48 + items.length * 22 + 24;
  doc.save();
  doc.roundedRect(MARGIN_X, cardY, CONTENT_WIDTH, cardH, 6).fill(C.white);
  doc.restore();

  doc.fillColor(C.ink3)
    .font(FONT_BOLD).fontSize(9)
    .text('CONTENTS', MARGIN_X + 24, cardY + 22, {
      characterSpacing: 1.5,
      width: CONTENT_WIDTH - 48,
    });

  let listY = cardY + 48;
  items.forEach(([label, value], i) => {
    if (i > 0) {
      doc.save();
      doc.strokeColor(C.ruleSoft).lineWidth(0.5)
        .moveTo(MARGIN_X + 24, listY - 6)
        .lineTo(MARGIN_X + CONTENT_WIDTH - 24, listY - 6)
        .stroke();
      doc.restore();
    }
    doc.fillColor(C.ink2).font(FONT_NORMAL).fontSize(11)
      .text(label, MARGIN_X + 24, listY, {
        width: (CONTENT_WIDTH - 48) * 0.55,
        lineBreak: false,
      });
    doc.fillColor(C.ink).font(FONT_BOLD).fontSize(11)
      .text(value, MARGIN_X + 24 + (CONTENT_WIDTH - 48) * 0.55, listY, {
        width: (CONTENT_WIDTH - 48) * 0.45,
        align: 'right',
        lineBreak: false,
      });
    listY += 22;
  });

  // Bottom warning
  doc.fillColor('#fda4af')
    .font(FONT_BOLD).fontSize(9)
    .text(
      data.includePasswords
        ? '⚠  CONTAINS PLAINTEXT CREDENTIALS — DO NOT SHARE OR STORE UNENCRYPTED'
        : 'DO NOT SHARE OR STORE UNENCRYPTED',
      MARGIN_X,
      PAGE_HEIGHT - 96,
      { width: CONTENT_WIDTH, characterSpacing: 1, align: 'center' },
    );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function renderCompanyDetails(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'Company Details';
  sectionBanner(doc, TITLE, data.company.name);
  const c = data.company;

  // Lead block — most important fields, full width
  if (c.quickNotes) field(doc, 'Quick notes', c.quickNotes, TITLE);

  subheading(doc, 'Identity', TITLE);
  fieldGrid(
    doc,
    [
      ['Name', c.name],
      ['Type', c.type],
      ['Slug', c.slug],
      ['Parent', c.parentName],
      ['Website', c.website],
      ['Created', formatDate(c.createdAt)],
    ],
    TITLE,
  );

  if (c.contactName || c.contactTitle || c.contactEmail || c.contactPhone) {
    subheading(doc, 'Primary Contact', TITLE);
    fieldGrid(
      doc,
      [
        ['Name', c.contactName],
        ['Title', c.contactTitle],
        ['Email', c.contactEmail],
        ['Phone', c.contactPhone],
      ],
      TITLE,
    );
  }

  if (c.generalEmail || c.phone || c.fax) {
    subheading(doc, 'Contact Info', TITLE);
    fieldGrid(
      doc,
      [
        ['General email', c.generalEmail],
        ['Phone', c.phone],
        ['Fax', c.fax],
      ],
      TITLE,
    );
  }

  if (c.addressLine1 || c.city || c.region || c.country) {
    subheading(doc, 'Address', TITLE);
    fieldGrid(
      doc,
      [
        ['Line 1', c.addressLine1],
        ['Line 2', c.addressLine2],
        ['City', c.city],
        ['Region / State', c.region],
        ['Postal code', c.postalCode],
        ['Country', c.country],
      ],
      TITLE,
    );
  }
}

function renderMembers(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'Team Members';
  sectionBanner(doc, TITLE, `${data.members.length} ${plural(data.members.length, 'member')}`);

  if (data.members.length === 0) {
    doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink3)
      .text('No members.', { oblique: true });
    return;
  }

  // Widths must sum to CONTENT_WIDTH (504). Email is the variable
  // column; we give it the slack.
  const table: TableSpec = {
    title: TITLE,
    headers: ['Name', 'Email', 'Role', 'Expires'],
    widths: [130, 192, 100, 82],
  };
  drawTableHeaderRow(doc, table);

  data.members.forEach((m, i) => {
    tableRow(
      doc,
      [
        m.name,
        m.email,
        m.role.toLowerCase().replace(/_/g, ' '),
        formatDate(m.expiresAt),
      ],
      table,
      i,
    );
  });
}

function renderAssets(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'Assets';
  sectionBanner(doc, TITLE, `${data.assets.length} ${plural(data.assets.length, 'asset')}`);

  // Group by layout
  const byLayout = new Map<string, typeof data.assets>();
  for (const asset of data.assets) {
    const list = byLayout.get(asset.layoutName) ?? [];
    list.push(asset);
    byLayout.set(asset.layoutName, list);
  }

  for (const [layout, assets] of byLayout) {
    subheading(doc, `${layout}  ·  ${assets.length}`, TITLE);
    for (const asset of assets) {
      drawAssetCard(doc, asset, TITLE);
    }
  }
}

function drawAssetCard(
  doc: PDFKit.PDFDocument,
  asset: CompanyExportData['assets'][number],
  sectionTitle: string,
): void {
  ensureRoom(doc, 60, sectionTitle);
  // Card opens with title + accent stripe; we DON'T pre-measure the
  // body because asset bodies vary wildly. Instead we draw the accent
  // as we go, segment by segment, so it tracks across page breaks.
  const startY = doc.y;
  const accentX = MARGIN_X;
  const titleX = MARGIN_X + 12;
  const innerWidth = CONTENT_WIDTH - 12;

  // Title row
  doc.save();
  doc.rect(accentX, startY, 3, 18).fill(C.cardAccent);
  doc.restore();
  doc.font(FONT_BOLD).fontSize(11).fillColor(C.ink)
    .text(pdfSafeUserText(asset.name), titleX, startY, {
      width: innerWidth,
      lineBreak: false,
    });
  doc.y = startY + 22;
  if (asset.reconstructionState) {
    doc.font(FONT_NORMAL).fontSize(8.5).fillColor(C.warn)
      .text(pdfSafeUserText(staleRecordLabel(asset.reconstructionState)), titleX, doc.y, { width: innerWidth });
    doc.moveDown(0.25);
  }

  for (const fv of asset.fields) {
    const raw = formatAssetFieldValue(fv);
    if (!raw) continue;
    const truncated = raw.length > ASSET_VALUE_MAX_CHARS;
    // Truncate the raw value, then display-encode: slicing an encoded
    // string could split a [U+...] marker and break reversibility.
    const text = pdfSafeUserText(truncated ? raw.slice(0, ASSET_VALUE_MAX_CHARS) : raw);

    ensureRoom(doc, 24, sectionTitle);
    const lineY = doc.y;
    doc.save();
    doc.rect(accentX, lineY, 1, 14).fill(C.cardBorder);
    doc.restore();
    doc.font(FONT_BOLD).fontSize(8).fillColor(C.ink3)
      .text(pdfSafeUserText(fv.label.toUpperCase()), titleX, lineY, {
        width: innerWidth,
        characterSpacing: 0.4,
      });
    doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink2)
      .text(text, titleX, doc.y, { width: innerWidth });
    if (truncated) {
      doc.font(FONT_NORMAL).fontSize(8).fillColor(C.ink3)
        .text(
          `[truncated — ${raw.length.toLocaleString()} chars total]`,
          titleX,
          doc.y,
          { width: innerWidth, oblique: true },
        );
    }
    doc.moveDown(0.3);
  }

  doc.moveDown(0.4);
  doc.save();
  doc.strokeColor(C.ruleSoft).lineWidth(0.5)
    .moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + CONTENT_WIDTH, doc.y).stroke();
  doc.restore();
  doc.moveDown(0.5);
}

function renderPasswords(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = data.includePasswords ? 'Passwords (Plaintext)' : 'Passwords';
  const SUBTITLE = data.includePasswords
    ? `${data.passwords.length} ${plural(data.passwords.length, 'entry')} · plaintext credentials included`
    : `${data.passwords.length} ${plural(data.passwords.length, 'entry')} · metadata only`;
  sectionBanner(doc, TITLE, SUBTITLE);

  if (data.passwords.length === 0) {
    doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink3)
      .text('No passwords.', { oblique: true });
    return;
  }

  // Warning callout
  drawCallout(
    doc,
    data.includePasswords
      ? 'This section contains plaintext passwords, notes, and TOTP secrets. Handle the PDF with extreme care.'
      : 'Plaintext passwords, notes, and TOTP secrets were intentionally omitted from this export.',
    data.includePasswords ? 'danger' : 'info',
  );

  for (const p of data.passwords) {
    drawPasswordCard(doc, p, data.includePasswords, TITLE);
  }
}

function drawPasswordCard(
  doc: PDFKit.PDFDocument,
  p: CompanyExportData['passwords'][number],
  includePlaintext: boolean,
  sectionTitle: string,
): void {
  ensureRoom(doc, 70, sectionTitle);
  const startY = doc.y;
  const titleX = MARGIN_X + 12;
  const innerWidth = CONTENT_WIDTH - 12;

  doc.save();
  doc.rect(MARGIN_X, startY, 3, 18).fill(C.cardAccent);
  doc.restore();

  // Measure the pwned badge first: it is right-aligned to the content
  // edge and the title must yield to its actual width (large breach
  // counts previously pushed the pill past the margin).
  const pwnedLabel =
    p.pwnedCount && p.pwnedCount > 0
      ? `Pwned · ${p.pwnedCount.toLocaleString()}`
      : null;
  const badgeW = pwnedLabel ? badgeWidth(doc, pwnedLabel) : 0;
  const titleWidth = innerWidth - (badgeW > 0 ? badgeW + 10 : 0);
  doc.font(FONT_BOLD).fontSize(11).fillColor(C.ink)
    .text(fitText(doc, pdfSafeUserText(p.name), titleWidth, FONT_BOLD, 11), titleX, startY, {
      width: titleWidth,
      lineBreak: false,
    });

  if (pwnedLabel) {
    drawBadge(doc, pwnedLabel, MARGIN_X + CONTENT_WIDTH - badgeW, startY, 'danger');
  }
  doc.y = startY + 22;

  fieldGrid(
    doc,
    [
      ['Folder', p.folderPath === '/' ? null : p.folderPath],
      ['Username', p.username],
      ['URL', p.url],
      ['Tags', p.tags.length > 0 ? p.tags.join(', ') : null],
    ],
    sectionTitle,
  );

  if (includePlaintext) {
    // Byte-exact or explicitly flagged — never silently rewritten
    // (CR-020). Notes are prose: parse the rich text first, then let
    // field() apply the display encoding to the extracted plaintext.
    credentialField(doc, 'Password', p.password, sectionTitle);
    credentialField(doc, 'TOTP secret', p.totpSecret, sectionTitle);
    const notes = richTextToPlaintext(p.notes);
    if (notes) field(doc, 'Notes', notes, sectionTitle);
  }

  fieldGrid(
    doc,
    [
      ['Last rotated', formatDate(p.lastRotatedAt)],
      ['Expires', formatDate(p.expiresAt)],
    ],
    sectionTitle,
  );

  doc.moveDown(0.3);
  doc.save();
  doc.strokeColor(C.ruleSoft).lineWidth(0.5)
    .moveTo(MARGIN_X, doc.y).lineTo(MARGIN_X + CONTENT_WIDTH, doc.y).stroke();
  doc.restore();
  doc.moveDown(0.5);
}

/** Pill width for `drawBadge`'s text at its fixed 8pt bold face. */
function badgeWidth(doc: PDFKit.PDFDocument, text: string): number {
  doc.font(FONT_BOLD).fontSize(8);
  return doc.widthOfString(text) + 14;
}

function drawBadge(
  doc: PDFKit.PDFDocument,
  text: string,
  x: number,
  y: number,
  tone: 'ok' | 'warn' | 'danger' | 'info',
): void {
  const palette =
    tone === 'ok'
      ? { fg: C.ok, bg: C.okBg }
      : tone === 'warn'
        ? { fg: C.warn, bg: C.warnBg }
        : tone === 'danger'
          ? { fg: C.danger, bg: C.dangerBg }
          : { fg: C.ink2, bg: C.badge };

  doc.font(FONT_BOLD).fontSize(8);
  const w = doc.widthOfString(text) + 14;
  doc.save();
  doc.roundedRect(x, y, w, 16, 8).fill(palette.bg);
  doc.fillColor(palette.fg).text(text, x + 7, capCenteredBaseline(y, 16, 8), {
    width: w - 14,
    lineBreak: false,
    baseline: 'alphabetic',
  });
  doc.restore();
}

function drawCallout(
  doc: PDFKit.PDFDocument,
  text: string,
  tone: 'danger' | 'info',
): void {
  // Measure first so we know the box height (and can page-break before
  // it would clip the bottom margin).
  doc.font(FONT_BOLD).fontSize(10);
  const textH = doc.heightOfString(text, { width: CONTENT_WIDTH - 24 });
  const boxH = textH + 16;
  ensureRoom(doc, boxH + 12);

  const startY = doc.y;
  const palette =
    tone === 'danger'
      ? { fg: C.danger, bg: C.dangerBg, border: '#fecaca' }
      : { fg: C.ink2, bg: C.badge, border: '#c7d2fe' };

  doc.save();
  doc.roundedRect(MARGIN_X, startY, CONTENT_WIDTH, boxH, 4).fill(palette.bg);
  doc.lineWidth(0.5).strokeColor(palette.border)
    .roundedRect(MARGIN_X, startY, CONTENT_WIDTH, boxH, 4).stroke();
  doc.restore();

  doc.fillColor(palette.fg).font(FONT_BOLD).fontSize(10)
    .text(text, MARGIN_X + 12, startY + 8, { width: CONTENT_WIDTH - 24 });
  doc.y = startY + boxH + 8;
}

function renderArticles(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'Articles';
  sectionBanner(
    doc,
    TITLE,
    `${data.articles.length} ${plural(data.articles.length, 'article')}`,
  );

  data.articles.forEach((a, i) => {
    // Every article opens on a fresh page; the first starts under the
    // section banner, the rest under the slim continuation banner.
    if (i > 0) {
      doc.addPage();
      drawSlimBanner(doc, TITLE);
    }

    doc.font(FONT_BOLD).fontSize(14).fillColor(C.ink)
      .text(pdfSafeUserText(a.title), MARGIN_X, doc.y, { width: CONTENT_WIDTH });
    doc.font(FONT_NORMAL).fontSize(9).fillColor(C.ink3)
      .text(
        pdfSafeUserText(`Folder: ${a.folderPath}  ·  Updated ${formatDate(a.updatedAt)}`),
        MARGIN_X,
        doc.y,
        { width: CONTENT_WIDTH },
      );
    if (a.reconstructionState) {
      doc.font(FONT_NORMAL).fontSize(8.5).fillColor(C.warn)
        .text(pdfSafeUserText(staleRecordLabel(a.reconstructionState)), MARGIN_X, doc.y, { width: CONTENT_WIDTH });
    }
    doc.moveDown(0.4);

    renderArticleBody(doc, a, TITLE);
  });
}

/**
 * Single article representation: markdown. Tiptap documents project
 * through the shared GFM walker so numbered lists, tables, task lists,
 * code fences, and headings survive into the PDF instead of being
 * flattened to plaintext (the old behavior dropped list numbering and
 * table structure entirely).
 */
function articleMarkdown(
  article: Pick<
    ExportArticle,
    'editorMode' | 'content' | 'markdownSource' | 'contentPlaintext'
  >,
): string {
  if (article.editorMode === 'tiptap') {
    const markdown = tiptapDocToMarkdown(article.content);
    if (markdown) return markdown;
    return article.contentPlaintext ?? '';
  }
  return article.markdownSource ?? article.contentPlaintext ?? '';
}

function renderArticleBody(
  doc: PDFKit.PDFDocument,
  article: ExportArticle,
  sectionTitle: string,
): void {
  const markdown = articleMarkdown(article);
  if (!markdown.trim()) return;
  const imagesById = new Map(
    article.images.map((image) => [image.uploadId.toLowerCase(), image]),
  );
  renderMarkdownBlocks(
    doc,
    parseMarkdownBlocks(markdown),
    imagesById,
    MARGIN_X,
    CONTENT_WIDTH,
    sectionTitle,
  );
}

// ---------------------------------------------------------------------------
// Markdown block rendering
// ---------------------------------------------------------------------------

const ARTICLE_TEXT_SIZE = 10;
const CODE_TEXT_SIZE = 8.5;
/** Body copy is 10pt under a 14pt article title; headings nest between. */
const HEADING_SIZES: Record<number, number> = {
  1: 13,
  2: 12,
  3: 11,
  4: 10.5,
  5: 10,
  6: 9.5,
};

function renderMarkdownBlocks(
  doc: PDFKit.PDFDocument,
  blocks: MarkdownBlock[],
  imagesById: Map<string, ExportArticle['images'][number]>,
  x: number,
  width: number,
  sectionTitle: string,
): void {
  for (const block of blocks) {
    renderMarkdownBlock(doc, block, imagesById, x, width, sectionTitle);
  }
}

function renderMarkdownBlock(
  doc: PDFKit.PDFDocument,
  block: MarkdownBlock,
  imagesById: Map<string, ExportArticle['images'][number]>,
  x: number,
  width: number,
  sectionTitle: string,
): void {
  switch (block.kind) {
    case 'heading': {
      const size = HEADING_SIZES[block.level] ?? 9.5;
      ensureRoom(doc, size * 2.6, sectionTitle);
      doc.moveDown(0.35);
      drawInlineRuns(doc, block.runs, x, width, {
        size,
        color: C.ink,
        baseFont: FONT_BOLD,
        sectionTitle,
      });
      doc.moveDown(0.2);
      return;
    }
    case 'paragraph':
      ensureRoom(doc, 26, sectionTitle);
      drawInlineRuns(doc, block.runs, x, width, {
        size: ARTICLE_TEXT_SIZE,
        color: C.ink2,
        baseFont: FONT_NORMAL,
        sectionTitle,
      });
      doc.moveDown(0.4);
      return;
    case 'list':
      renderMarkdownList(doc, block.items, imagesById, x, width, sectionTitle);
      doc.moveDown(0.3);
      return;
    case 'code':
      renderMarkdownCode(doc, block.lines, x, width, sectionTitle);
      return;
    case 'quote':
      renderMarkdownQuote(doc, block, imagesById, x, width, sectionTitle);
      return;
    case 'table':
      renderMarkdownTable(doc, block.rows, x, width, sectionTitle);
      return;
    case 'rule': {
      ensureRoom(doc, 16, sectionTitle);
      doc.moveDown(0.25);
      const y = doc.y;
      doc.save();
      doc.strokeColor(C.rule).lineWidth(0.75)
        .moveTo(x, y).lineTo(x + width, y).stroke();
      doc.restore();
      doc.moveDown(0.55);
      return;
    }
    case 'image':
      renderArticleImage(doc, imagesById, block, sectionTitle);
      return;
  }
}

interface InlineRunStyle {
  size: number;
  color: string;
  baseFont: string;
  sectionTitle: string;
}

/**
 * Draw styled inline runs as one wrapped flow. PDFKit's `continued`
 * option keeps a single line wrapper across calls, so font/color
 * changes mid-paragraph reflow correctly; both packaged fonts share
 * identical vertical metrics, so mixed-face lines keep one height.
 */
function drawInlineRuns(
  doc: PDFKit.PDFDocument,
  runs: MarkdownInlineRun[],
  x: number,
  width: number,
  style: InlineRunStyle,
): void {
  const drawable = runs.filter((run) => run.text.length > 0);
  if (drawable.length === 0) return;
  doc.x = x;
  drawable.forEach((run, index) => {
    doc.font(run.bold || style.baseFont === FONT_BOLD ? FONT_BOLD : FONT_NORMAL)
      .fontSize(style.size)
      .fillColor(run.link ? C.cardAccent : run.code ? C.ink : style.color);
    doc.text(pdfSafeUserText(run.text), {
      width,
      continued: index < drawable.length - 1,
      ...(run.italic ? { oblique: true } : {}),
      ...(run.strike ? { strike: true } : {}),
    });
  });
  doc.x = MARGIN_X;
}

function renderMarkdownList(
  doc: PDFKit.PDFDocument,
  items: MarkdownListItem[],
  imagesById: Map<string, ExportArticle['images'][number]>,
  x: number,
  width: number,
  sectionTitle: string,
): void {
  doc.font(FONT_NORMAL).fontSize(ARTICLE_TEXT_SIZE);
  const markerColumn = Math.max(
    14,
    ...items.map((item) =>
      item.task ? 15 : doc.widthOfString(item.marker) + 6,
    ),
  );
  for (const item of items) {
    ensureRoom(doc, 22, sectionTitle);
    const lineY = doc.y;
    if (item.task) {
      drawTaskCheckbox(doc, x, lineY, item.task === 'checked');
    } else {
      doc.font(FONT_NORMAL).fontSize(ARTICLE_TEXT_SIZE).fillColor(C.ink3)
        .text(item.marker, x, lineY, {
          width: markerColumn - 2,
          lineBreak: false,
        });
      doc.y = lineY;
    }
    if (item.runs.length > 0) {
      drawInlineRuns(doc, item.runs, x + markerColumn, width - markerColumn, {
        size: ARTICLE_TEXT_SIZE,
        color: C.ink2,
        baseFont: FONT_NORMAL,
        sectionTitle,
      });
    } else {
      // Marker-only item (all content is nested blocks): keep the row.
      doc.y = lineY + 14;
    }
    doc.moveDown(0.12);
    for (const child of item.children) {
      renderMarkdownBlock(
        doc,
        child,
        imagesById,
        x + markerColumn,
        width - markerColumn,
        sectionTitle,
      );
    }
  }
}

/**
 * Vector checkbox for task-list items. The packaged CJK fonts carry no
 * ☐/☑ glyphs, and the old plaintext path leaked literal "[x]" markers
 * into the PDF — drawing the mark keeps the semantics without tofu.
 */
function drawTaskCheckbox(
  doc: PDFKit.PDFDocument,
  x: number,
  textTop: number,
  checked: boolean,
): void {
  // Optically center an 8px box on the 10pt cap band (cap top sits
  // ~4.3px below the line-box top with the packaged fonts).
  const boxY = textTop + 3.9;
  doc.save();
  if (checked) {
    doc.roundedRect(x + 0.5, boxY, 8, 8, 1.5)
      .lineWidth(0.9)
      .fillAndStroke(C.okBg, C.ok);
    doc.moveTo(x + 2.6, boxY + 4.3)
      .lineTo(x + 4.1, boxY + 5.8)
      .lineTo(x + 6.6, boxY + 2.3)
      .lineWidth(1.1)
      .strokeColor(C.ok)
      .stroke();
  } else {
    doc.roundedRect(x + 0.5, boxY, 8, 8, 1.5)
      .lineWidth(0.9)
      .strokeColor(C.ink4)
      .stroke();
  }
  doc.restore();
}

/**
 * Fenced code: a seamless run of per-line background strips (so page
 * breaks need no box-height pre-measurement), preformatted text, no
 * whitespace collapsing.
 */
function renderMarkdownCode(
  doc: PDFKit.PDFDocument,
  lines: string[],
  x: number,
  width: number,
  sectionTitle: string,
): void {
  const content = lines.length > 0 ? lines : [''];
  const innerX = x + 8;
  const innerWidth = width - 16;
  const pad = 4;
  doc.moveDown(0.15);
  ensureRoom(doc, 30, sectionTitle);
  const paintPad = () => {
    doc.save();
    doc.rect(x, doc.y, width, pad).fill(C.cardBg);
    doc.restore();
    doc.y += pad;
  };
  paintPad();
  for (const raw of content) {
    const text = pdfSafeUserText(raw.replace(/\t/g, '  ')) || ' ';
    doc.font(FONT_NORMAL).fontSize(CODE_TEXT_SIZE);
    const lineHeight = doc.heightOfString(text, { width: innerWidth });
    if (doc.y + lineHeight > pageBottomBoundary()) {
      doc.addPage();
      drawSlimBanner(doc, sectionTitle);
      paintPad();
    }
    const lineY = doc.y;
    doc.save();
    doc.rect(x, lineY, width, lineHeight).fill(C.cardBg);
    doc.restore();
    doc.fillColor(C.ink2).text(text, innerX, lineY, { width: innerWidth });
    doc.y = lineY + lineHeight;
  }
  paintPad();
  doc.moveDown(0.5);
}

function renderMarkdownQuote(
  doc: PDFKit.PDFDocument,
  block: Extract<MarkdownBlock, { kind: 'quote' }>,
  imagesById: Map<string, ExportArticle['images'][number]>,
  x: number,
  width: number,
  sectionTitle: string,
): void {
  ensureRoom(doc, 26, sectionTitle);
  const startY = doc.y;
  const pagesBefore = doc.bufferedPageRange().count;
  renderMarkdownBlocks(doc, block.blocks, imagesById, x + 14, width - 14, sectionTitle);
  // The accent bar spans the quote on its final page; when the quote
  // crossed a page break the earlier portion keeps its indent, which
  // still reads as quoted.
  const barTop = doc.bufferedPageRange().count === pagesBefore ? startY : 44;
  const barHeight = doc.y - barTop - 6;
  if (barHeight > 2) {
    doc.save();
    doc.rect(x + 2, barTop, 2.5, barHeight).fill(C.cardBorder);
    doc.restore();
  }
  doc.moveDown(0.2);
}

function renderMarkdownTable(
  doc: PDFKit.PDFDocument,
  rows: string[][],
  x: number,
  width: number,
  sectionTitle: string,
): void {
  if (rows.length === 0) return;
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  // Beyond eight columns the cells are too narrow to wrap readably —
  // degrade to preformatted rows rather than emitting confetti.
  if (columnCount > 8) {
    renderMarkdownCode(
      doc,
      rows.map((row) => row.join(' | ')),
      x,
      width,
      sectionTitle,
    );
    return;
  }
  const baseWidth = Math.floor(width / columnCount);
  const widths = Array.from({ length: columnCount }, (_, index) =>
    index === columnCount - 1 ? width - baseWidth * (columnCount - 1) : baseWidth,
  );
  const [headerCells, ...bodyRows] = rows as [string[], ...string[][]];
  const table: TableSpec = {
    title: sectionTitle,
    headers: padCells(headerCells, columnCount).map((cell) => pdfSafeUserText(cell)),
    widths,
    x,
  };
  // A row taller than a continuation page cannot be drawn as a table
  // row at all (see MAX_WRAPPED_ROW_HEIGHT). Degrade the whole table to
  // preformatted rows — they paginate line-by-line and keep every
  // cell's content, where a clamped table row would truncate it.
  const pageTallRow = bodyRows.some((cells) =>
    encodedWrappedRowHeight(
      doc,
      padCells(cells, columnCount).map((cell) => pdfSafeUserText(cell)),
      table,
    ) > MAX_WRAPPED_ROW_HEIGHT,
  );
  if (pageTallRow) {
    renderMarkdownCode(
      doc,
      rows.map((row) => row.join(' | ')),
      x,
      width,
      sectionTitle,
    );
    return;
  }
  doc.moveDown(0.15);
  ensureRoom(doc, ROW_HEIGHT * 3, sectionTitle);
  drawTableHeaderRow(doc, table);
  bodyRows.forEach((cells, index) =>
    wrappedTableRow(doc, padCells(cells, columnCount), table, index),
  );
  doc.moveDown(0.4);
}

function padCells(cells: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_, index) => cells[index] ?? '');
}

function renderArticleImage(
  doc: PDFKit.PDFDocument,
  imagesById: Map<string, ExportArticle['images'][number]>,
  block: Extract<MarkdownBlock, { kind: 'image' }>,
  sectionTitle: string,
): void {
  const image = block.uploadId
    ? imagesById.get(block.uploadId.toLowerCase())
    : undefined;
  const label = image?.filename ?? block.label ?? 'embedded image';

  if (!image) {
    renderImageFallback(doc, label, 'not found', sectionTitle);
    return;
  }
  if (!isPdfEmbeddableImage(image.mimeType)) {
    renderImageFallback(doc, label, `${image.mimeType} is not embeddable`, sectionTitle);
    return;
  }
  // Before the `!image.data` check so a gate-skipped image reports its
  // true reason instead of 'file unavailable' (hydration never read it).
  const sizeBlock = pdfEmbedSizeBlockReason(image.width, image.height);
  if (sizeBlock) {
    renderImageFallback(doc, label, sizeBlock, sectionTitle);
    return;
  }
  if (!image.data) {
    renderImageFallback(doc, label, 'file unavailable', sectionTitle);
    return;
  }

  ensureRoom(doc, 168, sectionTitle);
  const startY = doc.y;
  const maxHeight = Math.min(220, pageBottomBoundary() - startY - 24);
  try {
    doc.image(image.data, MARGIN_X, startY, {
      fit: [CONTENT_WIDTH, maxHeight],
      align: 'center',
    });
    doc.y = startY + maxHeight + 4;
    doc.font(FONT_NORMAL).fontSize(8).fillColor(C.ink3)
      .text(pdfSafeUserText(label), MARGIN_X, doc.y, {
        width: CONTENT_WIDTH,
        align: 'center',
      });
    doc.moveDown(0.5);
  } catch {
    doc.y = startY;
    renderImageFallback(doc, label, 'unsupported image data', sectionTitle);
  }
}

function renderImageFallback(
  doc: PDFKit.PDFDocument,
  label: string,
  reason: string,
  sectionTitle: string,
): void {
  ensureRoom(doc, 24, sectionTitle);
  doc.font(FONT_NORMAL).fontSize(9).fillColor(C.ink3)
    .text(`[Image: ${pdfSafeUserText(label)} - ${reason}]`, MARGIN_X, doc.y, {
      width: CONTENT_WIDTH,
    });
  doc.moveDown(0.35);
}

// ---------------------------------------------------------------------------
// Markdown block parsing (GFM subset, line-based, dependency-free)
// ---------------------------------------------------------------------------

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE_RE = /^ {0,3}>\s?(.*)$/;
const RULE_RE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT_H1_RE = /^ {0,3}=+\s*$/;
const SETEXT_H2_RE = /^ {0,3}-{2,}\s*$/;
const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(\S.*)$/;
const STANDALONE_IMAGE_RE =
  /^ {0,3}!\[([^\]]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)\s*$/;
const TABLE_DIVIDER_RE =
  /^ {0,3}\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?\s*$/;
const TASK_PREFIX_RE = /^\[([ xX])\]\s+(.*)$/;

/**
 * Parse markdown into the block model the PDF renderer draws. Coverage
 * is the article editor's markdown dialect (what `tiptapDocToMarkdown`
 * emits plus common hand-authored GFM): headings, setext H1, ordered /
 * bullet / task lists with nesting, pipe tables, fenced code,
 * blockquotes, thematic breaks, and upload-backed images. Unknown
 * constructs degrade to paragraphs — never dropped.
 */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  return parseBlockLines(markdown.replace(/\r\n?/g, '\n').split('\n'), 0);
}

/**
 * Nesting cap for quotes and lists. Parsing recurses once per level, so
 * without a cap a crafted article (500KB of ">" fits the source limit)
 * would overflow the stack and kill the export job. Beyond the cap,
 * deeper structure degrades to paragraph text.
 */
const MARKDOWN_MAX_NESTING = 12;

function parseBlockLines(lines: string[], depth: number): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const runs = parseInlineRuns(paragraph.join('\n'));
    paragraph = [];
    if (runs.length > 0) blocks.push({ kind: 'paragraph', runs });
  };

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;

    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1]!;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index]!, marker)) {
        codeLines.push(lines[index]!);
        index += 1;
      }
      index += 1; // closing fence (or EOF)
      blocks.push({ kind: 'code', lines: codeLines });
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        runs: parseInlineRuns(heading[2]!),
      });
      index += 1;
      continue;
    }

    if (paragraph.length > 0 && SETEXT_H1_RE.test(line)) {
      const runs = parseInlineRuns(paragraph.join('\n'));
      paragraph = [];
      blocks.push({ kind: 'heading', level: 1, runs });
      index += 1;
      continue;
    }
    if (paragraph.length > 0 && SETEXT_H2_RE.test(line)) {
      const runs = parseInlineRuns(paragraph.join('\n'));
      paragraph = [];
      blocks.push({ kind: 'heading', level: 2, runs });
      index += 1;
      continue;
    }

    if (RULE_RE.test(line)) {
      flushParagraph();
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }

    if (QUOTE_RE.test(line) && depth < MARKDOWN_MAX_NESTING) {
      flushParagraph();
      const quoted: string[] = [];
      while (index < lines.length) {
        const quoteLine = QUOTE_RE.exec(lines[index]!);
        if (!quoteLine) break;
        quoted.push(quoteLine[1]!);
        index += 1;
      }
      blocks.push({ kind: 'quote', blocks: parseBlockLines(quoted, depth + 1) });
      continue;
    }

    const image = STANDALONE_IMAGE_RE.exec(line);
    if (image) {
      flushParagraph();
      const uploadId = extractUploadId(image[2]!);
      blocks.push({ kind: 'image', uploadId, label: image[1] || uploadId });
      index += 1;
      continue;
    }

    if (isTableStart(lines, index)) {
      flushParagraph();
      const rows: string[][] = [splitTableRow(lines[index]!)];
      index += 2; // header + divider
      while (
        index < lines.length &&
        lines[index]!.includes('|') &&
        lines[index]!.trim().length > 0 &&
        !LIST_ITEM_RE.test(lines[index]!)
      ) {
        rows.push(splitTableRow(lines[index]!));
        index += 1;
      }
      blocks.push({ kind: 'table', rows });
      continue;
    }

    const listStart = LIST_ITEM_RE.exec(line);
    // GFM: bullet lists interrupt paragraphs freely; ordered lists only
    // when numbered 1 (so prose like "1986. A fine year" stays prose).
    if (
      listStart &&
      depth < MARKDOWN_MAX_NESTING &&
      (paragraph.length === 0 || /^(?:[-*+]|1[.)])$/.test(listStart[2]!))
    ) {
      flushParagraph();
      const parsed = parseListAt(lines, index, depth);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return blocks;
}

function closesFence(line: string, opener: string): boolean {
  const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(
    close &&
      close[1]![0] === opener[0] &&
      close[1]!.length >= opener.length,
  );
}

function isTableStart(lines: string[], index: number): boolean {
  const line = lines[index]!;
  const divider = lines[index + 1];
  return (
    line.includes('|') &&
    divider !== undefined &&
    divider.includes('|') &&
    TABLE_DIVIDER_RE.test(divider) &&
    splitTableRow(line).length > 0
  );
}

/**
 * Split a row on unescaped pipes. A pipe is a delimiter only when
 * preceded by an EVEN number of backslashes: `\|` is a literal pipe,
 * but `\\|` is an escaped (literal) backslash followed by a delimiter —
 * a naive `\|`-replace gets that parity wrong and merges the cells.
 * Cells keep their raw text, backslashes included; the backslash
 * escapes themselves are decoded later by `inlinePlaintext`.
 */
function splitOnUnescapedPipes(content: string): string[] {
  const cells: string[] = [];
  let current = '';
  let backslashes = 0;
  for (const character of content) {
    if (character === '\\') {
      backslashes += 1;
      current += character;
      continue;
    }
    if (character === '|' && backslashes % 2 === 0) {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
    backslashes = 0;
  }
  cells.push(current);
  return cells;
}

/**
 * Split a pipe-table row into plaintext cells: split on unescaped
 * pipes, drop the empty edge cells produced by wrapping delimiters
 * (interior empty cells are real; a trailing `\|` never splits, so its
 * cell survives intact), fold `<br>` back to newlines, and strip
 * inline markdown down to its visible text.
 */
function splitTableRow(line: string): string[] {
  const cells = splitOnUnescapedPipes(line.trim());
  if (cells.length > 1 && cells[0]!.trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map((cell) =>
    inlinePlaintext(cell.replace(/<br\s*\/?>/gi, '\n').trim()),
  );
}

function parseListAt(
  lines: string[],
  start: number,
  depth: number,
): { block: MarkdownBlock; next: number } {
  const items: MarkdownListItem[] = [];
  const baseIndent = LIST_ITEM_RE.exec(lines[start]!)![1]!.length;
  let index = start;

  while (index < lines.length) {
    const head = LIST_ITEM_RE.exec(lines[index]!);
    if (!head) break;
    const marker = head[2]!;
    const contentIndent = head[1]!.length + marker.length + 1;
    const contentLines: string[] = [head[3]!];
    index += 1;

    while (index < lines.length) {
      const line = lines[index]!;
      if (line.trim().length === 0) {
        // Blank inside an item survives only when indented content
        // follows; otherwise the list (or this item) has ended.
        const following = lines[index + 1];
        if (
          following !== undefined &&
          following.trim().length > 0 &&
          leadingSpaces(following) >= contentIndent
        ) {
          contentLines.push('');
          index += 1;
          continue;
        }
        break;
      }
      const itemMatch = LIST_ITEM_RE.exec(line);
      if (itemMatch && itemMatch[1]!.length <= baseIndent + 1) break;
      if (leadingSpaces(line) >= contentIndent || itemMatch) {
        // Nested block or continuation — dedent to the item's column.
        contentLines.push(line.slice(Math.min(contentIndent, leadingSpaces(line))));
        index += 1;
        continue;
      }
      // Lazy continuation of the item's opening paragraph.
      contentLines.push(line);
      index += 1;
    }

    items.push(buildListItem(marker, contentLines, depth));

    // Blank lines between items keep the list alive when a sibling
    // item follows.
    let lookahead = index;
    while (lookahead < lines.length && lines[lookahead]!.trim().length === 0) {
      lookahead += 1;
    }
    const sibling =
      lookahead < lines.length ? LIST_ITEM_RE.exec(lines[lookahead]!) : null;
    if (
      sibling &&
      sibling[1]!.length >= baseIndent &&
      sibling[1]!.length <= baseIndent + 1
    ) {
      index = lookahead;
      continue;
    }
    break;
  }
  return { block: { kind: 'list', items }, next: index };
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function buildListItem(
  marker: string,
  contentLines: string[],
  depth: number,
): MarkdownListItem {
  let task: MarkdownListItem['task'] = null;
  let firstLine = contentLines[0] ?? '';
  const taskMatch = TASK_PREFIX_RE.exec(firstLine);
  if (taskMatch) {
    task = taskMatch[1] === ' ' ? 'unchecked' : 'checked';
    firstLine = taskMatch[2]!;
  }
  const blocks = parseBlockLines([firstLine, ...contentLines.slice(1)], depth + 1);
  const [headBlock, ...rest] = blocks;
  if (headBlock && headBlock.kind === 'paragraph') {
    return { marker: displayMarker(marker), task, runs: headBlock.runs, children: rest };
  }
  return { marker: displayMarker(marker), task, runs: [], children: blocks };
}

function displayMarker(marker: string): string {
  if (marker === '-' || marker === '*' || marker === '+') return '•';
  return marker.endsWith(')') ? `${marker.slice(0, -1)}.` : marker;
}

// ---------------------------------------------------------------------------
// Inline markdown parsing
// ---------------------------------------------------------------------------

// Ordered alternation: code spans bind tightest, then images/links,
// then emphasis. Underscore emphasis is deliberately not parsed —
// runbook text is full of snake_case identifiers, and the article
// editor's own projection only ever emits `*` emphasis.
const INLINE_TOKEN_RE = new RegExp(
  [
    '(?<codeticks>`+)(?<code>[\\s\\S]+?)\\k<codeticks>',
    '!\\[(?<imgalt>[^\\]]*)\\]\\((?<imgsrc>[^()\\s]+)(?:\\s+"[^"]*")?\\)',
    '\\[(?<linklabel>[^\\]]+)\\]\\((?<linkhref>[^()\\s]+)(?:\\s+"[^"]*")?\\)',
    '\\*\\*(?<bold>\\S|\\S[\\s\\S]*?\\S)\\*\\*',
    '\\*(?<italic>\\S|\\S[^*\\n]*?\\S)\\*',
    '~~(?<strike>\\S|\\S[\\s\\S]*?\\S)~~',
    '<br\\s*/?>',
  ].join('|'),
  'gi',
);

const MARKDOWN_ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!|~<>"'])/g;

type InlineStyleFlags = Pick<
  MarkdownInlineRun,
  'bold' | 'italic' | 'code' | 'strike' | 'link'
>;

function parseInlineRuns(
  text: string,
  base: InlineStyleFlags = {},
): MarkdownInlineRun[] {
  const runs: MarkdownInlineRun[] = [];
  appendInlineRuns(runs, text, base);
  return runs.filter((run) => run.text.length > 0);
}

function appendInlineRuns(
  runs: MarkdownInlineRun[],
  text: string,
  base: InlineStyleFlags,
): void {
  const push = (value: string, flags: InlineStyleFlags): void => {
    if (!value) return;
    const previous = runs[runs.length - 1];
    if (previous && sameInlineStyle(previous, flags)) {
      previous.text += value;
      return;
    }
    runs.push({ text: value, ...flags });
  };

  let cursor = 0;
  INLINE_TOKEN_RE.lastIndex = 0;
  for (const match of text.matchAll(INLINE_TOKEN_RE)) {
    push(unescapeMarkdown(text.slice(cursor, match.index)), base);
    cursor = match.index + match[0].length;
    const groups = match.groups ?? {};
    if (groups['code'] !== undefined) {
      push(groups['code'], { ...base, code: true });
    } else if (groups['imgsrc'] !== undefined) {
      // Inline (non-standalone) image: keep the alt text in the flow.
      push(unescapeMarkdown(groups['imgalt'] ?? ''), base);
    } else if (groups['linklabel'] !== undefined) {
      appendInlineRuns(runs, groups['linklabel'], { ...base, link: true });
    } else if (groups['bold'] !== undefined) {
      appendInlineRuns(runs, groups['bold'], { ...base, bold: true });
    } else if (groups['italic'] !== undefined) {
      appendInlineRuns(runs, groups['italic'], { ...base, italic: true });
    } else if (groups['strike'] !== undefined) {
      appendInlineRuns(runs, groups['strike'], { ...base, strike: true });
    } else {
      push('\n', base); // <br>
    }
  }
  push(unescapeMarkdown(text.slice(cursor)), base);
}

function sameInlineStyle(run: MarkdownInlineRun, flags: InlineStyleFlags): boolean {
  return (
    Boolean(run.bold) === Boolean(flags.bold) &&
    Boolean(run.italic) === Boolean(flags.italic) &&
    Boolean(run.code) === Boolean(flags.code) &&
    Boolean(run.strike) === Boolean(flags.strike) &&
    Boolean(run.link) === Boolean(flags.link)
  );
}

function unescapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_ESCAPE_RE, '$1');
}

function inlinePlaintext(text: string): string {
  return parseInlineRuns(text)
    .map((run) => run.text)
    .join('');
}

function extractUploadId(src: string): string | null {
  const match = ARTICLE_IMAGE_RE.exec(src);
  return match?.[1]?.toLowerCase() ?? null;
}

function isPdfEmbeddableImage(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return normalized === 'image/png' || normalized === 'image/jpeg';
}

/**
 * WS-027: pdfkit has no pixel limit, so we refuse to decode images whose
 * stored dimensions are unknown or exceed MAX_IMAGE_DECODE_PIXELS. Unknown
 * dims fail closed: sharp's metadata() throws for headers beyond ~268 MP,
 * so a large-enough decompression bomb is stored with null dims — exactly
 * the rows we must not hand to doc.image(). Returns the human-readable
 * reason for the PDF fallback line, or null when the image may be embedded.
 * Exported so the hydration pass and the render gate share one predicate.
 */
export function pdfEmbedSizeBlockReason(
  width: number | null | undefined,
  height: number | null | undefined,
): string | null {
  if (typeof width !== 'number' || typeof height !== 'number') {
    return 'image dimensions unavailable';
  }
  if (width * height > MAX_IMAGE_DECODE_PIXELS) {
    return 'image too large to embed';
  }
  return null;
}

function renderIpam(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'IP Address Management';
  const reservationCount = data.ipam.reduce(
    (total, subnet) => total + subnet.reservations.length,
    0,
  );
  const occupantCount = data.ipam.reduce(
    (total, subnet) => total + subnet.occupants.length,
    0,
  );
  sectionBanner(
    doc,
    TITLE,
    `${data.ipam.length} ${plural(data.ipam.length, 'subnet')} · ${reservationCount} reserved · ${occupantCount} occupied`,
  );
  if (data.ipam.length === 0) {
    doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink3)
      .text('No subnets or address assignments.', MARGIN_X, doc.y, {
        width: CONTENT_WIDTH,
        oblique: true,
      });
    return;
  }

  data.ipam.forEach((subnet, subnetIndex) => {
    if (subnetIndex > 0) ensureRoom(doc, 90, TITLE);
    subheading(doc, `${subnet.name} - ${subnet.cidr}`, TITLE);
    if (subnet.reconstructionState) {
      doc.font(FONT_NORMAL).fontSize(8.5).fillColor(C.warn)
        .text(pdfSafeUserText(staleRecordLabel(subnet.reconstructionState)), MARGIN_X, doc.y, { width: CONTENT_WIDTH });
      doc.moveDown(0.25);
    }
    fieldGrid(doc, [
      ['CIDR / Prefix', `${subnet.cidr} (/${subnet.prefix})`],
      ['VLAN', subnet.vlanId === null ? null : String(subnet.vlanId)],
      ['Gateway', subnet.gateway],
      ['DHCP range', subnet.dhcpRangeStart || subnet.dhcpRangeEnd
        ? `${subnet.dhcpRangeStart ?? '?'} - ${subnet.dhcpRangeEnd ?? '?'}`
        : null],
    ], TITLE);
    if (subnet.description) field(doc, 'Description', subnet.description, TITLE);

    if (subnet.reservations.length > 0) {
      subheading(doc, `Static / reserved addresses · ${subnet.reservations.length}`, TITLE);
      subnet.reservations.forEach((reservation) => {
        ensureRoom(doc, reservation.notes ? 64 : 42, TITLE);
        const y = doc.y;
        doc.save();
        doc.rect(MARGIN_X, y, 3, 18).fill(C.cardAccent);
        doc.restore();
        doc.font(FONT_BOLD).fontSize(10.5).fillColor(C.ink)
          .text(pdfSafeUserText(reservation.ipAddress), MARGIN_X + 12, y, {
            width: 110,
            lineBreak: false,
          });
        doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink2)
          .text(pdfSafeUserText(reservation.label), MARGIN_X + 126, y, {
            width: CONTENT_WIDTH - 126,
          });
        doc.y = Math.max(doc.y, y + 22);
        if (reservation.notes) {
          doc.font(FONT_NORMAL).fontSize(9).fillColor(C.ink3)
            .text(pdfSafeUserText(reservation.notes), MARGIN_X + 12, doc.y, {
              width: CONTENT_WIDTH - 12,
            });
        }
        doc.moveDown(0.35);
      });
    }

    if (subnet.occupants.length > 0) {
      subheading(doc, `Device / interface / IP links · ${subnet.occupants.length}`, TITLE);
      const table: TableSpec = {
        title: TITLE,
        headers: ['IP Address', 'Device', 'Interface / Field'],
        widths: [110, 190, 204],
      };
      drawTableHeaderRow(doc, table);
      subnet.occupants.forEach((occupant, index) => {
        wrappedTableRow(
          doc,
          [occupant.ipAddress, occupant.assetLabel, occupant.interfaceLabel],
          table,
          index,
        );
      });
    }
  });
}

function renderRelationships(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'Relationships / Topology';
  sectionBanner(
    doc,
    TITLE,
    `${data.relations.length} ${plural(data.relations.length, 'relationship')}`,
  );
  if (data.relations.length === 0) {
    doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink3)
      .text('No relationships or dependency links.', MARGIN_X, doc.y, {
        width: CONTENT_WIDTH,
        oblique: true,
      });
    return;
  }
  const table: TableSpec = {
    title: TITLE,
    headers: ['Source', 'Relationship', 'Target', 'Recorded'],
    widths: [150, 134, 150, 70],
  };
  drawTableHeaderRow(doc, table);
  data.relations.forEach((relation, index) => {
    wrappedTableRow(
      doc,
      [
        relation.source.label,
        relation.reconstructionState
          ? `${humanize(relation.relationType)}\n${staleRecordLabel(relation.reconstructionState)}`
          : humanize(relation.relationType),
        relation.target.label,
        formatDate(relation.createdAt),
      ],
      table,
      index,
    );
  });
}

function renderReconstruction(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'Reconstruction Dossier';
  const { summaries, gaps, provenance } = data.reconstruction;
  sectionBanner(
    doc,
    TITLE,
    `${summaries.length} summaries · ${provenance.length} source records · ${gaps.length} active gaps`,
  );
  if (summaries.length === 0 && gaps.length === 0 && provenance.length === 0) {
    doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink3)
      .text(
        'No reconstruction summaries, gaps, or source provenance.',
        MARGIN_X,
        doc.y,
        { width: CONTENT_WIDTH, oblique: true },
      );
    return;
  }

  if (summaries.length > 0) {
    subheading(doc, 'Completeness summaries', TITLE);
    for (const summary of summaries) {
      ensureRoom(doc, 122, TITLE);
      doc.font(FONT_BOLD).fontSize(11).fillColor(C.ink)
        .text(pdfSafeUserText(summary.resourceLabel), MARGIN_X, doc.y, { width: CONTENT_WIDTH });
      fieldGrid(doc, [
        ['Synchronized current', String(summary.counts.synchronizedCurrent)],
        ['Manually documented', String(summary.counts.manuallyDocumented)],
        ['Secret blocked', String(summary.counts.secretBlocked)],
        ['Missing', String(summary.counts.missing)],
        ['Stale', String(summary.counts.stale)],
        ['Synchronization error', String(summary.counts.synchronizationError)],
        ['Evaluated', formatDate(summary.evaluatedAt)],
        ['Last successful sync', formatDate(summary.lastSuccessfulSyncAt)],
      ], TITLE);
      doc.moveDown(0.35);
    }
  }

  if (provenance.length > 0) {
    subheading(doc, 'Source provenance and age', TITLE);
    for (const source of provenance) {
      const title = pdfSafeUserText(
        `${source.target.label} · ${humanize(source.state)}`,
      );
      const sourceFields: Array<[string, string | null | undefined]> = [
        ['Source', source.sourceLabel],
        ['Resource', humanize(source.sourceResource)],
        ['Ownership', source.ownership],
        ['State', humanize(source.state)],
        ['First seen', formatDate(source.firstSeenAt)],
        ['Last seen', formatDate(source.lastSeenAt)],
        ['Last synchronized', formatDate(source.lastSyncedAt)],
        ['Stale since', formatDate(source.staleSince)],
      ];
      doc.font(FONT_BOLD).fontSize(10.5);
      const titleHeight = doc.heightOfString(title, { width: CONTENT_WIDTH });
      ensureRoom(doc, titleHeight + measureFieldGrid(doc, sourceFields) + 12, TITLE);
      doc.font(FONT_BOLD).fontSize(10.5).fillColor(
        source.state === 'stale' ? C.warn : source.state === 'blocked' ? C.danger : C.ink,
      ).text(title, MARGIN_X, doc.y, { width: CONTENT_WIDTH });
      fieldGrid(doc, sourceFields, TITLE);
      doc.moveDown(0.35);
    }
  }

  if (gaps.length > 0) {
    subheading(doc, 'Safe completeness gaps', TITLE);
    gaps.forEach((gap) => drawReconstructionGap(doc, gap, TITLE));
  }
}

function drawReconstructionGap(
  doc: PDFKit.PDFDocument,
  gap: CompanyExportData['reconstruction']['gaps'][number],
  sectionTitle: string,
): void {
  const innerWidth = CONTENT_WIDTH - 24;
  // Display-encode before measuring — the drawn strings must be the
  // measured strings or the card box misfits its content.
  const heading = pdfSafeUserText(`${gap.resourceLabel} · ${humanize(gap.kind)}`);
  const target = gap.target ? ` · Target: ${gap.target.label}` : '';
  const footer = pdfSafeUserText(
    `First seen ${formatDate(gap.firstSeenAt)} · Last seen ${formatDate(gap.lastSeenAt)}${target}`,
  );
  const message = pdfSafeUserText(gap.message);
  doc.font(FONT_BOLD).fontSize(10);
  const headingHeight = doc.heightOfString(heading, { width: innerWidth });
  doc.font(FONT_NORMAL).fontSize(9.5);
  const messageHeight = doc.heightOfString(message, { width: innerWidth });
  doc.font(FONT_NORMAL).fontSize(8);
  const footerHeight = doc.heightOfString(footer, { width: innerWidth });
  const paddingTop = 10;
  const headingMessageGap = 6;
  const messageFooterGap = 8;
  const paddingBottom = 10;
  const boxHeight = paddingTop + headingHeight + headingMessageGap + messageHeight +
    messageFooterGap + footerHeight + paddingBottom;
  ensureRoom(doc, boxHeight + 10, sectionTitle);
  const y = doc.y;
  doc.save();
  doc.roundedRect(MARGIN_X, y, CONTENT_WIDTH, boxHeight, 4).fill(C.cardBg);
  doc.strokeColor(C.cardBorder).lineWidth(0.5)
    .roundedRect(MARGIN_X, y, CONTENT_WIDTH, boxHeight, 4).stroke();
  doc.restore();
  doc.font(FONT_BOLD).fontSize(10).fillColor(C.ink)
    .text(heading, MARGIN_X + 12, y + paddingTop, {
      width: innerWidth,
    });
  const messageY = y + paddingTop + headingHeight + headingMessageGap;
  doc.font(FONT_NORMAL).fontSize(9.5).fillColor(C.ink2)
    .text(message, MARGIN_X + 12, messageY, { width: innerWidth });
  const footerY = messageY + messageHeight + messageFooterGap;
  doc.font(FONT_NORMAL).fontSize(8).fillColor(C.ink3)
    .text(footer, MARGIN_X + 12, footerY, { width: innerWidth });
  doc.y = y + boxHeight + 8;
}

function renderDomains(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'Monitored Domains';
  sectionBanner(
    doc,
    TITLE,
    `${data.domains.length} ${plural(data.domains.length, 'domain')}`,
  );

  if (data.domains.length === 0) {
    doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink3)
      .text('No monitored domains.', MARGIN_X, doc.y, {
        width: CONTENT_WIDTH,
        oblique: true,
      });
    return;
  }

  // Widths sum to 504 (CONTENT_WIDTH).
  const table: TableSpec = {
    title: TITLE,
    headers: ['Hostname', 'Status', 'WHOIS Expires', 'TLS Expires', 'Last Check'],
    widths: [170, 70, 96, 90, 78],
  };
  drawTableHeaderRow(doc, table);

  data.domains.forEach((d, i) => {
    // Status cell uses palette colors — we emulate a badge feel by
    // recoloring the cell text.
    const palette = statusPalette(d.latestStatus);
    tableRow(
      doc,
      [
        d.hostname,
        d.latestStatus,
        formatDate(d.whoisExpiresAt),
        formatDate(d.tlsExpiresAt),
        formatDate(d.lastCheckedAt),
      ],
      table,
      i,
      { 1: palette.fg },
    );
  });
}

function renderUploads(doc: PDFKit.PDFDocument, data: CompanyExportData): void {
  const TITLE = 'Uploaded Files';
  sectionBanner(
    doc,
    TITLE,
    `${data.uploads.length} ${plural(data.uploads.length, 'file')}`,
  );

  // Widths sum to 504.
  const table: TableSpec = {
    title: TITLE,
    headers: ['Filename', 'MIME Type', 'Size', 'Uploaded'],
    widths: [220, 134, 70, 80],
    aligns: ['left', 'left', 'right', 'left'],
  };
  drawTableHeaderRow(doc, table);

  data.uploads.forEach((u, i) => {
    tableRow(
      doc,
      [u.filename, u.mimeType, formatBytes(u.sizeBytes), formatDate(u.createdAt)],
      table,
      i,
    );
  });
}
