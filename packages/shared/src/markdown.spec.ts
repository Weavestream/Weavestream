import { markdownExcerpt, markdownToPlaintext } from './markdown.js';

describe('markdownToPlaintext (search indexing)', () => {
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

  it('keeps underscores inside words, across lines and inline code', () => {
    const src =
      'Use `create_article` first.\n\n**Update:** `update_article` and my_file_name.ps1 change it.';
    const plain = markdownToPlaintext(src);
    expect(plain).toContain('create_article');
    expect(plain).toContain('update_article');
    expect(plain).toContain('my_file_name.ps1');
    expect(plain).not.toContain('**');
    expect(plain).not.toContain('`');
  });

  it('still strips real underscore emphasis', () => {
    expect(markdownToPlaintext('an _emphasised_ and __strong__ word')).toBe(
      'an emphasised and strong word',
    );
  });

  it('keeps fenced code contents searchable and drops the fences', () => {
    const src = 'Check the service:\n\n```powershell\nGet-Service -Name Spooler\n# not a heading\n```\n\nDone.';
    const plain = markdownToPlaintext(src);
    expect(plain).toContain('Get-Service -Name Spooler');
    expect(plain).toContain('# not a heading');
    expect(plain).not.toContain('```');
    expect(plain).not.toContain('powershell');
  });

  it('does not strip Markdown syntax inside code', () => {
    const plain = markdownToPlaintext('Run `ls *.log | grep _x_` now.');
    expect(plain).toBe('Run ls *.log | grep _x_ now.');
  });

  it('ignores private-use slot markers in the input', () => {
    expect(markdownToPlaintext('a 0 b `c`')).toBe('a 0 b c');
  });
});

describe('markdownExcerpt', () => {
  it('truncates with ellipsis', () => {
    const long = Array.from({ length: 200 }, () => 'word').join(' ');
    const ex = markdownExcerpt(`# H\n\n${long}`);
    expect(ex.length).toBeLessThanOrEqual(281);
    expect(ex.endsWith('…')).toBe(true);
  });

  it('strips image references so filename-as-alt does not leak into previews', () => {
    const src = '![image.jpg](https://cdn/x.jpg)\n\nReal prose for the card.';
    const ex = markdownExcerpt(src);
    expect(ex).not.toContain('image.jpg');
    expect(ex).toContain('Real prose for the card.');
  });
});
