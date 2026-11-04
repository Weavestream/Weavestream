import {
  MAX_MARKDOWN_SOURCE,
  markdownExcerpt,
  markdownToPlaintext,
  parseMarkdownImport,
  slugifyArticleTitle,
  suffixedArticleIdentity,
} from './markdown.js';
import { articleSlugSchema, articleTitleSchema } from './schemas/article.js';

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

describe('parseMarkdownImport', () => {
  function ok(src: string, name = 'file.md') {
    const r = parseMarkdownImport(src, name);
    if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
    return r;
  }

  it('uses a leading # heading and removes it from the body', () => {
    const r = ok('# VPN setup\n\nStep one.');
    expect(r.title).toBe('VPN setup');
    expect(r.markdownSource).toBe('Step one.');
  });

  it('prefers a later # H1 over a leading ## H2 and keeps the body', () => {
    const src = '## Overview\n\ntext\n\n# Real title\n\nmore';
    const r = ok(src);
    expect(r.title).toBe('Real title');
    expect(r.markdownSource).toBe(src);
  });

  it('finds a heading after an intro paragraph or badge and keeps the body', () => {
    const src = '[![build](https://x/badge.svg)](https://x)\n\n# Printer guide\n\nBody';
    const r = ok(src);
    expect(r.title).toBe('Printer guide');
    expect(r.markdownSource).toBe(src);
  });

  it('ignores headings inside ``` and ~~~ fences', () => {
    expect(ok('```\n# not a title\n```\n\n# Title\n').title).toBe('Title');
    expect(ok('~~~bash\n# comment\n~~~\n## Second\n').title).toBe('Second');
  });

  it('treats an unclosed fence as running to end of file', () => {
    expect(ok('Intro\n```\n# hidden\n', 'my_runbook.md').title).toBe('my runbook');
  });

  it('ignores a 4-space indented heading (indented code)', () => {
    expect(ok('    # code\n\ntext', 'notes.md').title).toBe('notes');
  });

  it('uses the first heading of any level when there is no H1', () => {
    const r = ok('### Small\n\nBody');
    expect(r.title).toBe('Small');
    expect(r.markdownSource).toBe('Body');
  });

  it('strips front matter and reads its title when there is no heading', () => {
    const r = ok('---\ntitle: "From FM"\ntags: [a]\n---\nBody only', 'x.md');
    expect(r.title).toBe('From FM');
    expect(r.markdownSource).toBe('Body only');
  });

  it('prefers a heading over front-matter title, and handles front matter without title', () => {
    expect(ok('---\ntitle: FM\n---\n# Heading\n\nBody').title).toBe('Heading');
    const r = ok('---\nauthor: me\n---\nBody', 'backup-policy.markdown');
    expect(r.title).toBe('backup policy');
    expect(r.markdownSource).toBe('Body');
  });

  it('falls back to the file name when there is no heading', () => {
    expect(ok('Just some prose.', 'Switch-Config_Notes.MD').title).toBe('Switch Config Notes');
  });

  it('keeps the heading as the body for a heading-only file', () => {
    const r = ok('# Only a title\n');
    expect(r.title).toBe('Only a title');
    expect(r.markdownSource).toBe('# Only a title\n');
  });

  it('rejects an empty file and an oversize file', () => {
    expect(parseMarkdownImport('  \n\n', 'a.md').ok).toBe(false);
    expect(parseMarkdownImport('---\ntitle: x\n---\n', 'a.md').ok).toBe(false);
    expect(parseMarkdownImport('a'.repeat(MAX_MARKDOWN_SOURCE + 1), 'a.md').ok).toBe(false);
  });

  it('normalizes CRLF and a BOM', () => {
    const r = ok('\uFEFF# Title\r\n\r\nLine one\r\nLine two');
    expect(r.title).toBe('Title');
    expect(r.markdownSource).toBe('Line one\nLine two');
  });

  it('cuts long headings to 200 characters', () => {
    expect(ok(`# ${'a'.repeat(300)}\n\nbody`).title).toHaveLength(200);
  });
});

describe('slugifyArticleTitle', () => {
  it('matches the API slug rules', () => {
    expect(slugifyArticleTitle('Hello, World!')).toBe('hello-world');
    expect(slugifyArticleTitle('  Café Déjà vu  ')).toBe('cafe-deja-vu');
    expect(slugifyArticleTitle('!!!')).toBe('untitled');
    expect(slugifyArticleTitle('a'.repeat(100))).toHaveLength(80);
  });
});

describe('suffixedArticleIdentity', () => {
  it('keeps a 200-character title within the schema limit', () => {
    const r = suffixedArticleIdentity('t'.repeat(200), 2);
    expect(r.title.length).toBeLessThanOrEqual(200);
    expect(r.title.endsWith(' 2')).toBe(true);
    expect(articleTitleSchema.safeParse(r.title).success).toBe(true);
  });

  it('gives distinct, valid slugs to titles sharing the first 80 slug characters', () => {
    const long = 'x'.repeat(90);
    const a = suffixedArticleIdentity(`${long} one`, 2);
    const b = suffixedArticleIdentity(`${long} one`, 3);
    expect(a.slug).not.toBe(b.slug);
    expect(a.slug).not.toBe(slugifyArticleTitle(`${long} one`));
    for (const s of [a.slug, b.slug]) {
      expect(s.length).toBeLessThanOrEqual(80);
      expect(articleSlugSchema.safeParse(s).success).toBe(true);
    }
  });

  it('keeps lengths for n = 10 and n = 100', () => {
    for (const n of [10, 100]) {
      const r = suffixedArticleIdentity('y'.repeat(200), n);
      expect(r.title.length).toBeLessThanOrEqual(200);
      expect(r.slug.length).toBeLessThanOrEqual(80);
      expect(r.slug.endsWith(`-${n}`)).toBe(true);
    }
  });

  it('removes a trailing dash left by the cut', () => {
    const r = suffixedArticleIdentity(`${'a'.repeat(77)} b`, 2);
    expect(articleSlugSchema.safeParse(r.slug).success).toBe(true);
  });

  it('falls back to untitled when the title has no slug characters', () => {
    expect(suffixedArticleIdentity('!!!', 2).slug).toBe('untitled-2');
  });
});
