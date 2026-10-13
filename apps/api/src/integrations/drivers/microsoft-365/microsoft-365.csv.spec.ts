import { parseCsv } from './microsoft-365.csv.js';

describe('parseCsv', () => {
  it('parses a BOM-prefixed report with CRLF rows', () => {
    const csv = '﻿Report Refresh Date,User Principal Name,Storage Used (Byte)\r\n2026-10-07,ada@contoso.example,1024\r\n';
    expect(parseCsv(csv)).toEqual([
      { 'Report Refresh Date': '2026-10-07', 'User Principal Name': 'ada@contoso.example', 'Storage Used (Byte)': '1024' },
    ]);
  });

  it('handles quoted commas, doubled quotes, line breaks, LF and blank lines', () => {
    const csv = 'A,B,C\n"x, y","say ""hi""","line1\nline2"\n\n1,2\n';
    expect(parseCsv(csv)).toEqual([
      { A: 'x, y', B: 'say "hi"', C: 'line1\nline2' },
      { A: '1', B: '2', C: '' },
    ]);
  });

  it('returns no rows for an empty or header-only report and caps the row count', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('A,B\r\n')).toEqual([]);
    expect(() => parseCsv('A\n1\n2\n3\n', 1)).toThrow('too many rows');
  });
});
