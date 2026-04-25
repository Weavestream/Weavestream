import { markdownExcerpt, markdownToPlaintext } from '@weavestream/shared';

describe('markdownToPlaintext (shared, search indexing)', () => {
  it('strips heading markers and emphasis', () => {
    const src = '# Heading\n\n**Body** keyword';
    const plain = markdownToPlaintext(src);
    expect(plain).toContain('keyword');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('#');
  });

  it('extracts link label text', () => {
    expect(markdownToPlaintext('[Runbook](https://x.com/a)')).toContain('Runbook');
  });
});

describe('markdownExcerpt', () => {
  it('truncates with ellipsis', () => {
    const long = Array.from({ length: 200 }, () => 'word').join(' ');
    const ex = markdownExcerpt(`# H\n\n${long}`);
    expect(ex.length).toBeLessThanOrEqual(281);
    expect(ex.endsWith('…')).toBe(true);
  });
});
