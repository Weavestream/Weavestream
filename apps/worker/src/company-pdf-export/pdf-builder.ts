import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { MAX_IMAGE_DECODE_PIXELS, tiptapToPlaintext } from '@weavestream/shared';
import type { CompanyExportData } from '../../../api/src/exports/company-export-data.service.js';

interface PdfBuildOpts {
  pdfPassword?: string;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const FONT_NORMAL = 'NotoSansCJK';
const FONT_BOLD = 'NotoSansCJKBold';
const FONT_OBLIQUE = 'NotoSansItalic';
const fontRequire = createRequire(__filename);
const FONT_NORMAL_PATH = fontRequire.resolve(
  'noto-fontface-cjk-jp/fonts/Noto/NotoSansCJKjp-Regular.otf',
);
const FONT_BOLD_PATH = fontRequire.resolve(
  'noto-fontface-cjk-jp/fonts/Noto/NotoSansCJKjp-Bold.otf',
);
const FONT_OBLIQUE_PATH = fontRequire.resolve(
  'notosans-fontface/fonts/NotoSans-Italic.ttf',
);

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

export type ArticleSegment =
  | { kind: 'text'; text: string }
  | { kind: 'image'; uploadId: string | null; fallbackLabel: string | null };

const ARTICLE_IMAGE_RE =
  /\/api\/v1\/companies\/[0-9a-f-]{36}\/uploads\/([0-9a-f-]{36})/i;

const TIPTAP_BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'bulletList',
  'orderedList',
  'codeBlock',
  'taskList',
  'taskItem',
  'table',
  'tableRow',
  'tableHeader',
  'tableCell',
  'horizontalRule',
]);

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function buildCompanyExportPdf(
  data: CompanyExportData,
  opts: PdfBuildOpts = {},
): Promise<Buffer> {
  data = encodePdfUserText(data);
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
        Title: `Vault Export - ${data.company.name}`,
        Author: 'Weavestream',
        CreationDate: data.exportedAt,
      },
      // PDFKit's `userPassword` opens the document; `ownerPassword`
      // controls printing/copying. We set them to the same value so a
      // single shared secret unlocks everything.
      ...(opts.pdfPassword
        ? { userPassword: opts.pdfPassword, ownerPassword: opts.pdfPassword }
        : {}),
    });
    doc.registerFont(FONT_NORMAL, FONT_NORMAL_PATH);
    doc.registerFont(FONT_BOLD, FONT_BOLD_PATH);
    doc.registerFont(FONT_OBLIQUE, FONT_OBLIQUE_PATH);

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
      renderReconstruction(doc, data);
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
  doc.fillColor(C.white)
    .font(FONT_BOLD).fontSize(20)
    .text(title, MARGIN_X, 22, { width: CONTENT_WIDTH, lineBreak: false });
  if (subtitle) {
    doc.fillColor('#cbd5e1')
      .font(FONT_NORMAL).fontSize(10)
      .text(subtitle, MARGIN_X, 46, { width: CONTENT_WIDTH, lineBreak: false });
  }
  doc.restore();
}

function drawSlimBanner(doc: PDFKit.PDFDocument, title: string): void {
  doc.save();
  doc.rect(0, 0, PAGE_WIDTH, 28).fill(C.banner);
  doc.fillColor(C.white)
    .font(FONT_BOLD).fontSize(11)
    .text(`${title} (continued)`, MARGIN_X, 9, {
      width: CONTENT_WIDTH,
      lineBreak: false,
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
  ensureRoom(doc, 30, sectionTitle);
  doc.font(FONT_BOLD).fontSize(8).fillColor(C.ink3)
    .text(label.toUpperCase(), MARGIN_X, doc.y, {
      width: CONTENT_WIDTH,
      characterSpacing: 0.4,
    });
  doc.font(FONT_NORMAL).fontSize(10.5).fillColor(C.ink)
    .text(value, MARGIN_X, doc.y, { width: CONTENT_WIDTH });
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
  const present = pairs.filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  ) as Array<[string, string]>;
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
  const present = pairs.filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  ) as Array<[string, string]>;
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
    .text(text, MARGIN_X, doc.y, { width: CONTENT_WIDTH });
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
}

function drawTableHeaderRow(doc: PDFKit.PDFDocument, table: TableSpec): void {
  const headerY = doc.y;
  // Header background pill.
  doc.save();
  doc.rect(MARGIN_X, headerY - 4, CONTENT_WIDTH, ROW_HEIGHT).fill(C.banner);
  doc.fillColor(C.white).font(FONT_BOLD).fontSize(9);
  let x = MARGIN_X + 6;
  table.headers.forEach((h, i) => {
    const w = table.widths[i]! - 12;
    const align = table.aligns?.[i] ?? 'left';
    doc.text(h, x, headerY, { width: w, lineBreak: false, align });
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
  if (doc.y + ROW_HEIGHT > pageBottomBoundary()) {
    doc.addPage();
    drawSlimBanner(doc, table.title);
    drawTableHeaderRow(doc, table);
  }

  const rowY = doc.y;
  // Zebra striping
  if (rowIndex % 2 === 1) {
    doc.save();
    doc.rect(MARGIN_X, rowY - 2, CONTENT_WIDTH, ROW_HEIGHT).fill(C.zebra);
    doc.restore();
  }

  let x = MARGIN_X + 6;
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

function wrappedTableRow(
  doc: PDFKit.PDFDocument,
  cols: string[],
  table: TableSpec,
  rowIndex: number,
): void {
  doc.font(FONT_NORMAL).fontSize(8.5);
  const cellHeights = cols.map((col, index) =>
    doc.heightOfString(col, { width: table.widths[index]! - 12 }),
  );
  const rowHeight = Math.max(ROW_HEIGHT, ...cellHeights.map((height) => height + 10));
  if (doc.y + rowHeight > pageBottomBoundary()) {
    doc.addPage();
    drawSlimBanner(doc, table.title);
    drawTableHeaderRow(doc, table);
  }

  const rowY = doc.y;
  if (rowIndex % 2 === 1) {
    doc.save();
    doc.rect(MARGIN_X, rowY - 2, CONTENT_WIDTH, rowHeight).fill(C.zebra);
    doc.restore();
  }
  let x = MARGIN_X + 6;
  cols.forEach((col, index) => {
    const cellWidth = table.widths[index]! - 12;
    doc.font(FONT_NORMAL).fontSize(8.5).fillColor(C.ink)
      .text(col, x, rowY + 4, { width: cellWidth, align: table.aligns?.[index] ?? 'left' });
    x += table.widths[index]!;
  });
  doc.y = rowY + rowHeight;
}

/**
 * Pixel-perfect ellipsis truncation. Linear shrink is plenty fast for
 * cell-sized strings (a few hundred chars max); we don't need a binary
 * search here.
 */
function fitText(
  doc: PDFKit.PDFDocument,
  text: string,
  maxWidth: number,
  font: string,
  size: number,
): string {
  doc.font(font).fontSize(size);
  if (doc.widthOfString(text) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && doc.widthOfString(cut + '…') > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return cut + '…';
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

function formatDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return `${new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(d)} UTC`;
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

export function pdfSafeUserText(value: string): string {
  let encoded = '';
  for (const { segment } of PDF_GRAPHEME_SEGMENTER.segment(value)) {
    const codePoints = [...segment].map((character) => character.codePointAt(0)!);
    if (codePoints.every(isPackagedPdfCodePoint)) {
      encoded += segment;
      continue;
    }
    encoded += `[U+${codePoints
      .map((codePoint) => codePoint.toString(16).toUpperCase().padStart(4, '0'))
      .join('+')}]`;
  }
  return encoded;
}

function isPackagedPdfCodePoint(codePoint: number): boolean {
  return codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0x024f) ||
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0400 && codePoint <= 0x052f) ||
    (codePoint >= 0x2000 && codePoint <= 0x206f && codePoint !== 0x200d) ||
    (codePoint >= 0x20a0 && codePoint <= 0x20cf) ||
    (codePoint >= 0x2100 && codePoint <= 0x214f) ||
    (codePoint >= 0x3000 && codePoint <= 0x30ff) ||
    (codePoint >= 0x31f0 && codePoint <= 0x31ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef);
}

function encodePdfUserText<T>(value: T): T {
  if (typeof value === 'string') {
    return pdfSafeUserText(value) as T;
  }
  if (value instanceof Date || Buffer.isBuffer(value) || value === null) return value;
  if (Array.isArray(value)) return value.map((entry) => encodePdfUserText(entry)) as T;
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, encodePdfUserText(entry)]),
    ) as T;
  }
  return value;
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
      .text(
        `Confidential · Vault Archive · ${data.company.name}`,
        MARGIN_X,
        y,
        { width: CONTENT_WIDTH * 0.7, lineBreak: false },
      );
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
    .text(`${data.workspaceName.toUpperCase()} · CONFIDENTIAL`, MARGIN_X, 96, {
      width: CONTENT_WIDTH,
      characterSpacing: 1.5,
    });

  doc.fillColor(C.white)
    .font(FONT_BOLD).fontSize(40)
    .text('Vault Archive', MARGIN_X, 140, { width: CONTENT_WIDTH });

  doc.fillColor('#cbd5e1')
    .font(FONT_NORMAL).fontSize(20)
    .text(data.company.name, MARGIN_X, 200, { width: CONTENT_WIDTH });

  doc.fillColor('#94a3b8')
    .font(FONT_NORMAL).fontSize(10)
    .text(
      `Exported ${data.exportedAt.toUTCString()}`,
      MARGIN_X,
      244,
      { width: CONTENT_WIDTH },
    );

  // Summary card
  const cardY = 382;
  const cardH = 292;
  doc.save();
  doc.roundedRect(MARGIN_X, cardY, CONTENT_WIDTH, cardH, 6).fill(C.white);
  doc.restore();

  doc.fillColor(C.ink3)
    .font(FONT_BOLD).fontSize(9)
    .text('CONTENTS', MARGIN_X + 24, cardY + 22, {
      characterSpacing: 1.5,
      width: CONTENT_WIDTH - 48,
    });

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
    [
      'Reconstruction dossier',
      `${data.reconstruction.gaps.length} active ${plural(data.reconstruction.gaps.length, 'gap')}`,
    ],
    [
      'Monitored domains',
      `${data.domains.length} ${plural(data.domains.length, 'domain')}`,
    ],
    [
      'Uploaded files',
      `${data.uploads.length} ${plural(data.uploads.length, 'file')}`,
    ],
  ];

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
    doc.font(FONT_OBLIQUE).fontSize(10).fillColor(C.ink3).text('No members.');
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
    .text(asset.name, titleX, startY, { width: innerWidth, lineBreak: false });
  doc.y = startY + 22;
  if (asset.reconstructionState) {
    doc.font(FONT_NORMAL).fontSize(8.5).fillColor(C.warn)
      .text(staleRecordLabel(asset.reconstructionState), titleX, doc.y, { width: innerWidth });
    doc.moveDown(0.25);
  }

  for (const fv of asset.fields) {
    const raw = formatAssetFieldValue(fv);
    if (!raw) continue;
    const truncated = raw.length > ASSET_VALUE_MAX_CHARS;
    const text = truncated ? raw.slice(0, ASSET_VALUE_MAX_CHARS) : raw;

    ensureRoom(doc, 24, sectionTitle);
    const lineY = doc.y;
    doc.save();
    doc.rect(accentX, lineY, 1, 14).fill(C.cardBorder);
    doc.restore();
    doc.font(FONT_BOLD).fontSize(8).fillColor(C.ink3)
      .text(`${fv.label.toUpperCase()}`, titleX, lineY, {
        width: innerWidth,
        characterSpacing: 0.4,
      });
    doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink2)
      .text(text, titleX, doc.y, { width: innerWidth });
    if (truncated) {
      doc.font(FONT_OBLIQUE).fontSize(8).fillColor(C.ink3)
        .text(
          `[truncated — ${raw.length.toLocaleString()} chars total]`,
          titleX,
          doc.y,
          { width: innerWidth },
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
    doc.font(FONT_OBLIQUE).fontSize(10).fillColor(C.ink3).text('No passwords.');
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

  doc.font(FONT_BOLD).fontSize(11).fillColor(C.ink)
    .text(p.name, titleX, startY, { width: innerWidth - 90, lineBreak: false });

  // Right-side meta: pwned badge if applicable
  if (p.pwnedCount && p.pwnedCount > 0) {
    drawBadge(
      doc,
      `Pwned · ${p.pwnedCount.toLocaleString()}`,
      MARGIN_X + CONTENT_WIDTH - 90,
      startY,
      'danger',
    );
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
    // Credential strings use the full width. Reversible U+ fallback
    // notation must not lose punctuation at narrow column line wraps.
    field(doc, 'Password', p.password, sectionTitle);
    field(doc, 'TOTP secret', p.totpSecret, sectionTitle);
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
  doc.fillColor(palette.fg).text(text, x + 7, y + 4, {
    width: w - 14,
    lineBreak: false,
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
    if (i > 0) ensureRoom(doc, 80, TITLE);

    doc.font(FONT_BOLD).fontSize(14).fillColor(C.ink)
      .text(a.title, MARGIN_X, doc.y, { width: CONTENT_WIDTH });
    doc.font(FONT_NORMAL).fontSize(9).fillColor(C.ink3)
      .text(`Folder: ${a.folderPath}  ·  Updated ${formatDate(a.updatedAt)}`, MARGIN_X, doc.y, { width: CONTENT_WIDTH });
    if (a.reconstructionState) {
      doc.font(FONT_NORMAL).fontSize(8.5).fillColor(C.warn)
        .text(staleRecordLabel(a.reconstructionState), MARGIN_X, doc.y, { width: CONTENT_WIDTH });
    }
    doc.moveDown(0.4);

    renderArticleBody(doc, a, TITLE);
    doc.moveDown(0.6);

    // Soft separator between articles (only if there are more to come).
    if (i < data.articles.length - 1) {
      doc.save();
      doc.strokeColor(C.ruleSoft).lineWidth(0.5)
        .moveTo(MARGIN_X, doc.y)
        .lineTo(MARGIN_X + CONTENT_WIDTH, doc.y)
        .stroke();
      doc.restore();
      doc.moveDown(0.6);
    }
  });
}

function renderArticleBody(
  doc: PDFKit.PDFDocument,
  article: ExportArticle,
  sectionTitle: string,
): void {
  if (article.editorMode !== 'tiptap') {
    renderArticleText(doc, article.contentPlaintext ?? '', sectionTitle);
    return;
  }

  const segments = articleSegmentsFromTiptap(article.content);
  if (segments.length === 0) {
    renderArticleText(doc, article.contentPlaintext ?? '', sectionTitle);
    return;
  }

  const imagesById = new Map(
    article.images.map((image) => [image.uploadId.toLowerCase(), image]),
  );
  for (const segment of segments) {
    if (segment.kind === 'text') {
      renderArticleText(doc, segment.text, sectionTitle);
    } else {
      renderArticleImage(doc, imagesById, segment, sectionTitle);
    }
  }
}

function renderArticleText(
  doc: PDFKit.PDFDocument,
  text: string,
  sectionTitle: string,
): void {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return;
  ensureRoom(doc, 28, sectionTitle);
  doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink2)
    .text(clean, MARGIN_X, doc.y, {
      width: CONTENT_WIDTH,
      align: 'left',
      paragraphGap: 4,
    });
  doc.moveDown(0.3);
}

function renderArticleImage(
  doc: PDFKit.PDFDocument,
  imagesById: Map<string, ExportArticle['images'][number]>,
  segment: Extract<ArticleSegment, { kind: 'image' }>,
  sectionTitle: string,
): void {
  const image = segment.uploadId
    ? imagesById.get(segment.uploadId.toLowerCase())
    : undefined;
  const label = image?.filename ?? segment.fallbackLabel ?? 'embedded image';

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
      .text(label, MARGIN_X, doc.y, { width: CONTENT_WIDTH, align: 'center' });
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
    .text(`[Image: ${label} - ${reason}]`, MARGIN_X, doc.y, {
      width: CONTENT_WIDTH,
    });
  doc.moveDown(0.35);
}

export function articleSegmentsFromTiptap(value: unknown): ArticleSegment[] {
  const segments: ArticleSegment[] = [];

  const appendText = (text: string) => {
    if (!text) return;
    const previous = segments[segments.length - 1];
    if (previous?.kind === 'text') {
      previous.text += text;
      return;
    }
    segments.push({ kind: 'text', text });
  };

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as {
      type?: string;
      text?: string;
      attrs?: Record<string, unknown>;
      content?: unknown[];
    };

    if (n.type === 'text' && typeof n.text === 'string') {
      appendText(n.text);
      return;
    }
    if (n.type === 'hardBreak' || n.type === 'horizontalRule') {
      appendText('\n');
      return;
    }
    if (n.type === 'mention' || n.type === 'internalLink') {
      const label = stringAttr(n.attrs, 'label') ?? stringAttr(n.attrs, 'title');
      if (label) appendText(label);
      return;
    }
    if (n.type === 'image') {
      const src = stringAttr(n.attrs, 'src');
      const uploadId = src ? extractUploadId(src) : null;
      const fallbackLabel =
        stringAttr(n.attrs, 'alt') ?? stringAttr(n.attrs, 'title') ?? uploadId;
      segments.push({ kind: 'image', uploadId, fallbackLabel });
      return;
    }

    const children = Array.isArray(n.content) ? n.content : [];
    for (const child of children) walk(child);
    if (n.type && TIPTAP_BLOCK_TYPES.has(n.type)) appendText('\n');
  };

  walk(value);
  return segments.filter((segment) =>
    segment.kind === 'image' ? true : segment.text.trim().length > 0,
  );
}

function stringAttr(
  attrs: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
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
    doc.font(FONT_OBLIQUE).fontSize(10).fillColor(C.ink3)
      .text('No subnets or address assignments.', MARGIN_X, doc.y, { width: CONTENT_WIDTH });
    return;
  }

  data.ipam.forEach((subnet, subnetIndex) => {
    if (subnetIndex > 0) ensureRoom(doc, 90, TITLE);
    subheading(doc, `${subnet.name} - ${subnet.cidr}`, TITLE);
    if (subnet.reconstructionState) {
      doc.font(FONT_NORMAL).fontSize(8.5).fillColor(C.warn)
        .text(staleRecordLabel(subnet.reconstructionState), MARGIN_X, doc.y, { width: CONTENT_WIDTH });
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
          .text(reservation.ipAddress, MARGIN_X + 12, y, {
            width: 110,
            lineBreak: false,
          });
        doc.font(FONT_NORMAL).fontSize(10).fillColor(C.ink2)
          .text(reservation.label, MARGIN_X + 126, y, {
            width: CONTENT_WIDTH - 126,
          });
        doc.y = Math.max(doc.y, y + 22);
        if (reservation.notes) {
          doc.font(FONT_NORMAL).fontSize(9).fillColor(C.ink3)
            .text(reservation.notes, MARGIN_X + 12, doc.y, {
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
    doc.font(FONT_OBLIQUE).fontSize(10).fillColor(C.ink3)
      .text('No relationships or dependency links.', MARGIN_X, doc.y, { width: CONTENT_WIDTH });
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
    doc.font(FONT_OBLIQUE).fontSize(10).fillColor(C.ink3)
      .text(
        'No reconstruction summaries, gaps, or source provenance.',
        MARGIN_X,
        doc.y,
        { width: CONTENT_WIDTH },
      );
    return;
  }

  if (summaries.length > 0) {
    subheading(doc, 'Completeness summaries', TITLE);
    for (const summary of summaries) {
      ensureRoom(doc, 122, TITLE);
      doc.font(FONT_BOLD).fontSize(11).fillColor(C.ink)
        .text(summary.resourceLabel, MARGIN_X, doc.y, { width: CONTENT_WIDTH });
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
      const title = `${source.target.label} · ${humanize(source.state)}`;
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
  const heading = `${gap.resourceLabel} · ${humanize(gap.kind)}`;
  const target = gap.target ? ` · Target: ${gap.target.label}` : '';
  const footer = `First seen ${formatDate(gap.firstSeenAt)} · Last seen ${formatDate(gap.lastSeenAt)}${target}`;
  doc.font(FONT_BOLD).fontSize(10);
  const headingHeight = doc.heightOfString(heading, { width: innerWidth });
  doc.font(FONT_NORMAL).fontSize(9.5);
  const messageHeight = doc.heightOfString(gap.message, { width: innerWidth });
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
    .text(gap.message, MARGIN_X + 12, messageY, { width: innerWidth });
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
    doc.font(FONT_OBLIQUE).fontSize(10).fillColor(C.ink3)
      .text('No monitored domains.', MARGIN_X, doc.y, { width: CONTENT_WIDTH });
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
