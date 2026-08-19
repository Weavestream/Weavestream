import { slugifyFieldSlug, slugifyLayoutSlug } from './slugify';

describe('slugify', () => {
  it('lowercases, strips punctuation, and collapses whitespace to underscores', () => {
    for (const fn of [slugifyLayoutSlug, slugifyFieldSlug]) {
      expect(fn('Domain Controller')).toBe('domain_controller');
      expect(fn('  Firewall / Router!  ')).toBe('firewall_router');
      expect(fn('Serial #12-34')).toBe('serial_1234');
      expect(fn('already_snake_case')).toBe('already_snake_case');
      expect(fn('Tabs\tand\nnewlines')).toBe('tabs_and_newlines');
      expect(fn('')).toBe('');
      expect(fn('!!!')).toBe('');
    }
  });

  it('caps a layout slug at 48 characters and a field slug at 60', () => {
    const long = 'a'.repeat(100);
    expect(slugifyLayoutSlug(long)).toHaveLength(48);
    expect(slugifyFieldSlug(long)).toHaveLength(60);
  });

  it('applies the cap after the transform, so it can cut mid-word', () => {
    // 10 words of 5 chars + separators = 59 chars; the layout cap lands inside
    // the 9th word while the field cap keeps the whole string.
    const words = Array.from({ length: 10 }, (_, i) => `word${i}`).join(' ');
    expect(slugifyLayoutSlug(words)).toBe(slugifyFieldSlug(words).slice(0, 48));
    expect(slugifyLayoutSlug(words)).toHaveLength(48);
  });

  it('is otherwise the same transform — the two differ only in the cap', () => {
    for (const s of ['Short', 'A B C', 'Mixed_Case Thing 42']) {
      expect(slugifyLayoutSlug(s)).toBe(slugifyFieldSlug(s));
    }
  });
});
