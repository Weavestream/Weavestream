import { differenceDisplayValue, mergeFieldDiffs, parseFieldDiffs } from './field-diffs.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const diff = (source: string, local = 'l1') => ({ sourceValue: source, sourceFingerprint: `s:${source}`, localFingerprint: local });

describe('mergeFieldDiffs', () => {
  it('stamps a new difference with now and keeps detectedAt while nothing changes', () => {
    const first = mergeFieldDiffs({ f1: diff('a') }, {}, {}, NOW);
    expect(first.fieldDiffs.f1).toEqual({ ...diff('a'), detectedAt: NOW.toISOString() });
    const later = mergeFieldDiffs({ f1: diff('a') }, first.fieldDiffs, {}, new Date('2026-10-10T00:00:00.000Z'));
    expect(later.fieldDiffs.f1!.detectedAt).toBe(NOW.toISOString());
  });

  it('Keep ours suppresses the difference until the source value changes', () => {
    const kept = { f1: { choice: 'local', sourceFingerprint: 's:a' } };
    const same = mergeFieldDiffs({ f1: diff('a') }, {}, kept, NOW);
    expect(same.fieldDiffs).toEqual({});
    expect(same.fieldResolutions).toEqual(kept);
    const changed = mergeFieldDiffs({ f1: diff('b') }, {}, kept, NOW);
    expect(changed.fieldDiffs.f1).toMatchObject({ sourceValue: 'b' });
    expect(changed.fieldResolutions).toEqual({});
  });

  it('drops differences and choices that no longer apply, and malformed rows', () => {
    const merged = mergeFieldDiffs({}, { f1: { ...diff('a'), detectedAt: NOW.toISOString() } }, { f1: { choice: 'local', sourceFingerprint: 's:a' } }, NOW);
    expect(merged).toEqual({ fieldDiffs: {}, fieldResolutions: {} });
    expect(parseFieldDiffs({ f1: { sourceFingerprint: 1 }, f2: 'x' })).toEqual({});
  });

  it('renders values as display text', () => {
    expect(differenceDisplayValue(null)).toBeNull();
    expect(differenceDisplayValue('')).toBeNull();
    expect(differenceDisplayValue(16)).toBe('16');
    expect(differenceDisplayValue(['a', 'b'])).toBe('a, b');
  });
});
