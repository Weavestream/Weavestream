import { boundedInt, isRecord, parseCssWidth, str } from './attr';

describe('str', () => {
  it('passes strings and rejects everything else', () => {
    expect(str('x')).toBe('x');
    expect(str('')).toBe('');
    expect(str(1)).toBeNull();
    expect(str({})).toBeNull();
    expect(str(null)).toBeNull();
    expect(str(undefined)).toBeNull();
  });
});

describe('boundedInt', () => {
  it('accepts finite numbers, truncated and clamped', () => {
    expect(boundedInt(3, 1, 6)).toBe(3);
    expect(boundedInt(3.9, 1, 6)).toBe(3);
    expect(boundedInt(0, 1, 6)).toBe(1);
    expect(boundedInt(99999, 1, 1000)).toBe(1000);
    expect(boundedInt(-5, 1, 6)).toBe(1);
  });

  it('accepts strictly numeric strings only', () => {
    expect(boundedInt('4', 1, 6)).toBe(4);
    expect(boundedInt(' 4 ', 1, 6)).toBe(4);
    expect(boundedInt('4px', 1, 6)).toBeUndefined();
  });

  it('rejects non-numeric JSON types that Number() would happily coerce', () => {
    expect(boundedInt(true, 1, 6)).toBeUndefined();
    expect(boundedInt([], 1, 6)).toBeUndefined();
    expect(boundedInt('', 1, 6)).toBeUndefined();
    expect(boundedInt(null, 1, 6)).toBeUndefined();
    expect(boundedInt(undefined, 1, 6)).toBeUndefined();
    expect(boundedInt(NaN, 1, 6)).toBeUndefined();
    expect(boundedInt(Infinity, 1, 6)).toBeUndefined();
    expect(boundedInt({}, 1, 6)).toBeUndefined();
  });
});

describe('parseCssWidth', () => {
  it('parses the desktop editor\'s "320px" string form', () => {
    expect(parseCssWidth('320px')).toBe(320);
  });

  it('parses bare numbers and numeric strings', () => {
    expect(parseCssWidth(320)).toBe(320);
    expect(parseCssWidth('320')).toBe(320);
    expect(parseCssWidth('320.5px')).toBe(321);
  });

  it('clamps to 1–2000', () => {
    expect(parseCssWidth(99999)).toBe(2000);
    expect(parseCssWidth(0)).toBeNull();
    expect(parseCssWidth(-10)).toBeNull();
  });

  it('rejects percentages, keywords, and garbage', () => {
    expect(parseCssWidth('50%')).toBeNull();
    expect(parseCssWidth('auto')).toBeNull();
    expect(parseCssWidth(true)).toBeNull();
    expect(parseCssWidth([])).toBeNull();
    expect(parseCssWidth('')).toBeNull();
    expect(parseCssWidth(null)).toBeNull();
  });
});

describe('isRecord', () => {
  it('accepts plain objects, rejects null/arrays/primitives', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ type: 'paragraph' })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('x')).toBe(false);
    expect(isRecord(7)).toBe(false);
  });
});
