/**
 * CSV encoding for files that operators open in a spreadsheet.
 *
 * Every cell is quoted (RFC 4180), and a cell that a spreadsheet would
 * read as a formula is neutralized first (CSV/formula injection, OWASP).
 * Excel, LibreOffice, and Google Sheets all evaluate a cell that starts
 * with `=`, `+`, `-`, or `@` — `=HYPERLINK("http://evil", "Click")` in
 * an asset name would otherwise become a live link or a DDE call in the
 * operator's spreadsheet. A leading TAB, CR, or LF is also stripped by
 * some importers before the check, so those trigger too, as do the
 * full-width forms that some locales fold into their ASCII equivalents.
 *
 * The UTF-8 byte order mark makes Excel read the file as UTF-8 instead
 * of the system code page; CRLF is the RFC 4180 line end.
 */

const FORMULA_TRIGGERS = new Set([
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
  '\n',
  '＝', // ＝ full-width equals
  '＋', // ＋ full-width plus
  '－', // － full-width hyphen-minus
  '＠', // ＠ full-width commercial at
]);

/** A plain decimal number cannot run as a formula, so `-5` stays `-5`. */
const STRICT_NUMBER = /^-?\d+(\.\d+)?$/;

const BOM = '﻿';

export function neutralizeFormula(value: string): string {
  if (value.length === 0) return value;
  if (!FORMULA_TRIGGERS.has(value[0]!)) return value;
  if (STRICT_NUMBER.test(value)) return value;
  return `'${value}`;
}

export function csvCell(value: string): string {
  return `"${neutralizeFormula(value).replace(/"/g, '""')}"`;
}

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(','));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
