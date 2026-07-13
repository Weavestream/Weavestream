import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadAppHelpIndex,
  searchAppHelpIndex,
} from './app-help.service.js';

const REAL_CONTENT = resolve(__dirname, 'content');
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'weavestream-app-help-'));
  tempRoots.push(root);
  return root;
}

function validDoc(body = 'Follow these steps.'): string {
  return [
    '# Asset help',
    '',
    '## Create an asset',
    '<!-- aliases: new asset | add device -->',
    '<!-- requires: asset.write -->',
    '',
    body,
  ].join('\n');
}

describe('loadAppHelpIndex', () => {
  it('parses H2 sections, validates metadata, and strips hidden comments', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'assets.md'), validDoc(), 'utf8');

    const index = loadAppHelpIndex(root);
    expect(index.sections).toHaveLength(1);
    expect(index.sections[0]).toMatchObject({
      documentId: 'assets',
      sectionId: 'assets/create-an-asset',
      documentTitle: 'Asset help',
      sectionTitle: 'Create an asset',
      requiredPermissions: ['asset.write'],
    });
    expect(index.sections[0]!.markdown).toBe(
      '## Create an asset\n\nFollow these steps.',
    );
    expect(index.sections[0]!.markdown).not.toContain('aliases:');
  });

  it.each([
    ['missing H1', '## Task\n\nBody'],
    ['second H1', '# One\n\n# Two\n\n## Task\n\nBody'],
    ['missing H2', '# One\n\nBody'],
    ['malformed aliases', '# One\n\n## Task\n<!-- aliases: -->\nBody'],
    [
      'unknown permission',
      '# One\n\n## Task\n<!-- requires: root.everything -->\nBody',
    ],
    ['empty section', '# One\n\n## Task\n<!-- aliases: thing -->'],
  ])('rejects %s', (_label, source) => {
    const root = tempRoot();
    writeFileSync(join(root, 'bad.md'), source, 'utf8');
    expect(() => loadAppHelpIndex(root)).toThrow();
  });

  it('rejects duplicate derived section ids', () => {
    const root = tempRoot();
    writeFileSync(
      join(root, 'dupe.md'),
      '# Dupe\n\n## Same task\n\nOne\n\n## Same task\n\nTwo',
      'utf8',
    );
    expect(() => loadAppHelpIndex(root)).toThrow('Duplicate app-help section id');
  });

  it('rejects oversized files and sections instead of truncating instructions', () => {
    const fileRoot = tempRoot();
    writeFileSync(join(fileRoot, 'large.md'), validDoc('x'.repeat(65_000)), 'utf8');
    expect(() => loadAppHelpIndex(fileRoot)).toThrow('exceeds 64000 bytes');

    const sectionRoot = tempRoot();
    writeFileSync(
      join(sectionRoot, 'section.md'),
      validDoc('x'.repeat(6_000)),
      'utf8',
    );
    expect(() => loadAppHelpIndex(sectionRoot)).toThrow('exceeds 6000 characters');
  });

  it('rejects symlinked files and symlinked corpus roots', () => {
    const outside = tempRoot();
    writeFileSync(join(outside, 'outside.md'), validDoc(), 'utf8');

    const root = tempRoot();
    symlinkSync(join(outside, 'outside.md'), join(root, 'escape.md'));
    expect(() => loadAppHelpIndex(root)).toThrow('must not contain symlinks');

    const parent = tempRoot();
    const linkedRoot = join(parent, 'content');
    symlinkSync(outside, linkedRoot);
    expect(() => loadAppHelpIndex(linkedRoot)).toThrow(
      'content directory must not be a symlink',
    );
  });

  it('rejects a missing or empty corpus and invalid document paths', () => {
    const root = tempRoot();
    expect(() => loadAppHelpIndex(join(root, 'missing'))).toThrow();
    expect(() => loadAppHelpIndex(root)).toThrow('contains no Markdown files');

    const invalid = tempRoot();
    mkdirSync(join(invalid, 'Bad Folder'));
    writeFileSync(join(invalid, 'Bad Folder', 'help.md'), validDoc(), 'utf8');
    expect(() => loadAppHelpIndex(invalid)).toThrow('Invalid app-help document path');
  });
});

describe('searchAppHelpIndex', () => {
  const index = loadAppHelpIndex(REAL_CONTENT);

  it.each([
    ['How do I create an asset?', 'assets/create-an-asset'],
    [
      'How do I add a dropdown field to a server template?',
      'asset-layouts/add-and-arrange-layout-fields',
    ],
    [
      'How do integrations work?',
      'integrations/how-asset-import-integrations-work',
    ],
    ['Connect NinjaOne RMM', 'integrations/configure-ninjaone-rmm'],
    [
      'Where do I map an RMM customer to a company?',
      'integration-mappings/map-an-upstream-organization-to-a-company',
    ],
    [
      'How can I stop imported devices being duplicated?',
      'integration-mappings/configure-match-keys',
    ],
    [
      'How do I set up intergation field maping?',
      'integration-mappings/configure-field-projections',
    ],
    ['Preview a sync without changes', 'integration-syncs/preview-with-a-dry-run'],
    ['Run imports automatically every six hours', 'integration-syncs/schedule-automatic-syncs'],
    [
      'Register a Cloudflare Gateway IP list',
      'integrations/configure-cloudflare-zero-trust-lists',
    ],
  ])('retrieves the expected guide for %s', (question, expectedId) => {
    const out = searchAppHelpIndex(index, question, 'test-version');
    expect(out.version).toBe('test-version');
    expect(out.matches).toHaveLength(Math.min(out.matches.length, 3));
    expect(out.matches[0]?.sectionId).toBe(expectedId);
    expect(out.matches[0]?.markdown).not.toContain('<!--');
  });

  it.each([
    'How do I configure the Docker container?',
    'Which environment variable changes the database?',
    'Which integrations are currently configured?',
    'Why did the latest sync fail?',
    'Is NinjaOne connected?',
    'asset',
    'integration',
  ])('returns no result for unsupported question: %s', (question) => {
    expect(searchAppHelpIndex(index, question).matches).toEqual([]);
  });

  it('returns at most three complete sections', () => {
    const out = searchAppHelpIndex(index, 'integration mapping sync fields');
    expect(out.matches.length).toBeLessThanOrEqual(3);
    expect(out.matches.every((m) => m.markdown.length <= 6_000)).toBe(true);
  });
});
