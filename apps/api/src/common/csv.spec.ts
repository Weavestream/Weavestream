import { csvCell, neutralizeFormula, toCsv } from './csv.js';

describe('neutralizeFormula', () => {
  it.each([
    ['=1+1'],
    ['+cmd'],
    ['-2+3'],
    ['@SUM(A1)'],
    ['\t=1+1'],
    ['\r=1+1'],
    ['\n=1+1'],
    ['＝1+1'],
    ['＋1'],
    ['－1'],
    ['＠SUM(A1)'],
    ['=HYPERLINK("http://example.test","x")'],
  ])('prefixes %j with a quote', (value) => {
    expect(neutralizeFormula(value)).toBe(`'${value}`);
  });

  it('prefixes a phone number that starts with +', () => {
    expect(neutralizeFormula('+1 555 0100')).toBe("'+1 555 0100");
  });

  it.each([['-5'], ['-0.25'], ['42'], ['0']])('leaves the plain number %j alone', (value) => {
    expect(neutralizeFormula(value)).toBe(value);
  });

  it('leaves ordinary text and empty values alone', () => {
    expect(neutralizeFormula('SN-1234')).toBe('SN-1234');
    expect(neutralizeFormula('a=b')).toBe('a=b');
    expect(neutralizeFormula('')).toBe('');
  });
});

describe('csvCell', () => {
  it('quotes every cell and doubles embedded quotes', () => {
    expect(csvCell('plain')).toBe('"plain"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('')).toBe('""');
  });

  it('neutralizes before quoting', () => {
    expect(csvCell('=1+1')).toBe(`"'=1+1"`);
    expect(csvCell('=A1&"x"')).toBe(`"'=A1&""x"""`);
  });
});

describe('toCsv', () => {
  it('writes a BOM, CRLF line ends, and a trailing CRLF', () => {
    const out = toCsv(['Name', 'Serial'], [['srv-1', 'ABC'], ['srv-2', '']]);
    expect(out).toBe('﻿"Name","Serial"\r\n"srv-1","ABC"\r\n"srv-2",""\r\n');
  });

  it('neutralizes header cells too', () => {
    expect(toCsv(['=evil'], [])).toBe(`﻿"'=evil"\r\n`);
  });
});
