/**
 * Small RFC 4180 CSV parser for Microsoft 365 usage reports (no new
 * dependency): a UTF-8 BOM is dropped, fields may be quoted, a quote inside
 * a quoted field is doubled, quoted fields may hold commas and line breaks,
 * and rows end in CRLF or LF. Returns one object per data row keyed by the
 * header; blank lines are skipped and a short row leaves missing keys empty.
 */
export function parseCsv(input: string, maxRows = 200_000): Array<Record<string, string>> {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
    if (rows.length > maxRows + 1) throw new Error('CSV report has too many rows');
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      endRow();
      i += 1;
    } else if (ch === '\n' || ch === '\r') endRow();
    else field += ch;
    i += 1;
  }
  if (field !== '' || row.length > 0) endRow();
  const [header, ...data] = rows;
  if (!header) return [];
  const keys = header.map((h) => h.trim());
  return data.map((cells) => Object.fromEntries(keys.map((k, idx) => [k, cells[idx] ?? ''])));
}
