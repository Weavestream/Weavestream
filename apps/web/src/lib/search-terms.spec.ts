import { editsActiveSearch, parseSearchTerms, withSearchTerm } from './search-terms';

describe('parseSearchTerms', () => {
  it('reads one term, several terms, or none', () => {
    expect(parseSearchTerms(undefined)).toEqual([]);
    expect(parseSearchTerms('dell')).toEqual(['dell']);
    expect(parseSearchTerms(['dell', '10.2.4'])).toEqual(['dell', '10.2.4']);
  });

  it('trims, drops blanks, and keeps the first of a repeated term', () => {
    expect(parseSearchTerms([' dell ', '', '  ', 'DELL', 'lab'])).toEqual(['dell', 'lab']);
  });
});

describe('withSearchTerm', () => {
  it('appends a trimmed new term', () => {
    expect(withSearchTerm(['dell'], ' lab ')).toEqual(['dell', 'lab']);
  });

  it('returns null for a blank or repeated term', () => {
    expect(withSearchTerm(['dell'], '  ')).toBeNull();
    expect(withSearchTerm(['dell'], 'Dell')).toBeNull();
  });
});

describe('editsActiveSearch', () => {
  it('is false when the 1st term starts a search', () => {
    expect(editsActiveSearch([], ['dell'])).toBe(false);
  });

  it('is true when terms are added to or removed from an active search', () => {
    expect(editsActiveSearch(['dell'], ['dell', 'lab'])).toBe(true);
    expect(editsActiveSearch(['dell', 'lab'], ['dell'])).toBe(true);
    expect(editsActiveSearch(['dell'], [])).toBe(true);
  });

  it('is false when the terms do not change', () => {
    expect(editsActiveSearch(['dell', 'lab'], ['dell', 'lab'])).toBe(false);
  });
});
