import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { AppHelpMatch, GetAppHelpToolOutput } from '@weavestream/shared';
import { ActionValues } from '../rbac/permissions.js';

const MAX_FILES = 100;
const MAX_FILE_BYTES = 64_000;
const MAX_TOTAL_BYTES = 2_000_000;
const MAX_SECTION_CHARS = 6_000;
const MAX_ALIASES = 20;
const MAX_RESULTS = 3;
const AMBIGUOUS_SINGLE_TERMS = new Set([
  'asset',
  'field',
  'integration',
  'layout',
  'mapping',
  'sync',
]);

const DEFAULT_CONTENT_DIR = resolve(__dirname, 'content');
const ALIASES_RE = /^<!-- aliases: (.+) -->$/;
const REQUIRES_RE = /^<!-- requires: (.+) -->$/;
const APP_HELP_META_RE = /<!--\s*(aliases|requires)\s*:/i;
const PERMISSION_SET = new Set<string>(ActionValues);

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'can',
  'do',
  'does',
  'for',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'the',
  'to',
  'we',
  'what',
  'which',
  'where',
  'with',
]);

interface IndexedSection extends AppHelpMatch {
  aliases: string[];
  documentNorm: string;
  sectionNorm: string;
  aliasNorms: string[];
  documentKey: string;
  sectionKey: string;
  aliasKeys: string[];
  bodyTokens: Set<string>;
  strongTokens: Set<string>;
}

export interface AppHelpIndex {
  sections: IndexedSection[];
}

/**
 * Loads and searches the immutable, release-bundled app-help corpus.
 * The model supplies only a question; file discovery is wholly server-
 * controlled and completed once at service construction.
 */
@Injectable()
export class AppHelpService {
  private readonly index: AppHelpIndex;

  constructor() {
    this.index = loadAppHelpIndex(DEFAULT_CONTENT_DIR);
  }

  search(question: string): GetAppHelpToolOutput {
    return searchAppHelpIndex(
      this.index,
      question,
      process.env.WEAVESTREAM_VERSION ?? 'dev',
    );
  }
}

export function loadAppHelpIndex(contentDir: string): AppHelpIndex {
  if (lstatSync(contentDir).isSymbolicLink()) {
    throw new Error('App-help content directory must not be a symlink.');
  }
  const root = realpathSync(contentDir);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory()) {
    throw new Error('App-help content path is not a directory.');
  }

  const files: string[] = [];
  let totalBytes = 0;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const candidate = resolve(dir, entry.name);
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink()) {
        throw new Error(`App-help content must not contain symlinks: ${entry.name}`);
      }
      if (stat.isDirectory()) {
        walk(candidate);
        continue;
      }
      if (!stat.isFile() || extname(entry.name).toLowerCase() !== '.md') continue;

      const actual = realpathSync(candidate);
      assertContained(root, actual);
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(`App-help file exceeds ${MAX_FILE_BYTES} bytes: ${entry.name}`);
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`App-help corpus exceeds ${MAX_TOTAL_BYTES} bytes.`);
      }
      files.push(actual);
      if (files.length > MAX_FILES) {
        throw new Error(`App-help corpus exceeds ${MAX_FILES} Markdown files.`);
      }
    }
  };
  walk(root);

  if (files.length === 0) {
    throw new Error('App-help corpus contains no Markdown files.');
  }

  const sections: IndexedSection[] = [];
  const seenIds = new Set<string>();
  for (const file of files.sort()) {
    const documentId = documentIdFor(root, file);
    for (const section of parseAppHelpDocument(
      documentId,
      readFileSync(file, 'utf8'),
    )) {
      if (seenIds.has(section.sectionId)) {
        throw new Error(`Duplicate app-help section id: ${section.sectionId}`);
      }
      seenIds.add(section.sectionId);
      sections.push(indexSection(section));
    }
  }
  return { sections };
}

export function searchAppHelpIndex(
  index: AppHelpIndex,
  question: string,
  version = 'dev',
): GetAppHelpToolOutput {
  if (isUnsupportedLiveStateQuestion(question)) {
    return { version, matches: [] };
  }

  const queryTokens = meaningfulTokens(question);
  if (queryTokens.length === 0) return { version, matches: [] };
  if (queryTokens.length === 1 && AMBIGUOUS_SINGLE_TERMS.has(queryTokens[0]!)) {
    return { version, matches: [] };
  }
  const phrase = queryTokens.join(' ');

  const ranked = index.sections
    .map((section) => scoreSection(section, queryTokens, phrase))
    .filter((result): result is { section: IndexedSection; score: number } =>
      result !== null,
    )
    .sort(
      (a, b) =>
        b.score - a.score || a.section.sectionId.localeCompare(b.section.sectionId),
    )
    .slice(0, MAX_RESULTS)
    .map(({ section }): AppHelpMatch => ({
      documentId: section.documentId,
      sectionId: section.sectionId,
      documentTitle: section.documentTitle,
      sectionTitle: section.sectionTitle,
      requiredPermissions: section.requiredPermissions,
      markdown: section.markdown,
    }));

  return { version, matches: ranked };
}

function parseAppHelpDocument(
  documentId: string,
  source: string,
): AppHelpMatchWithAliases[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  const h1 = firstContent >= 0 ? /^# ([^#].*)$/.exec(lines[firstContent]!) : null;
  if (!h1) throw new Error(`App-help document ${documentId} must start with one # title.`);
  if (lines.slice(firstContent + 1).some((line) => /^# [^#]/.test(line))) {
    throw new Error(`App-help document ${documentId} contains more than one # title.`);
  }
  const documentTitle = cleanTitle(h1[1]!, documentId);

  const starts: number[] = [];
  for (let i = firstContent + 1; i < lines.length; i += 1) {
    if (/^## [^#]/.test(lines[i]!)) starts.push(i);
  }
  if (starts.length === 0) {
    throw new Error(`App-help document ${documentId} has no ## task sections.`);
  }

  const out: AppHelpMatchWithAliases[] = [];
  for (let idx = 0; idx < starts.length; idx += 1) {
    const start = starts[idx]!;
    const end = starts[idx + 1] ?? lines.length;
    const headingMatch = /^## ([^#].*)$/.exec(lines[start]!);
    if (!headingMatch) throw new Error(`Malformed section heading in ${documentId}.`);
    const sectionTitle = cleanTitle(headingMatch[1]!, documentId);
    const sectionSlug = slugify(sectionTitle);
    if (!sectionSlug) throw new Error(`App-help section in ${documentId} has no usable id.`);

    const aliases: string[] = [];
    const requiredPermissions: string[] = [];
    const body: string[] = [];
    for (const rawLine of lines.slice(start + 1, end)) {
      const line = rawLine.trim();
      const aliasMatch = ALIASES_RE.exec(line);
      const requiresMatch = REQUIRES_RE.exec(line);
      if (aliasMatch) {
        if (aliases.length > 0) {
          throw new Error(`Duplicate aliases metadata in ${documentId}/${sectionSlug}.`);
        }
        aliases.push(...splitMetadata(aliasMatch[1]!, 'alias', documentId));
        if (aliases.length > MAX_ALIASES) {
          throw new Error(`Too many aliases in ${documentId}/${sectionSlug}.`);
        }
        continue;
      }
      if (requiresMatch) {
        if (requiredPermissions.length > 0) {
          throw new Error(`Duplicate requires metadata in ${documentId}/${sectionSlug}.`);
        }
        const permissions = splitMetadata(
          requiresMatch[1]!,
          'permission',
          documentId,
        );
        for (const permission of permissions) {
          if (!PERMISSION_SET.has(permission)) {
            throw new Error(
              `Unknown app-help permission "${permission}" in ${documentId}/${sectionSlug}.`,
            );
          }
        }
        requiredPermissions.push(...permissions);
        if (requiredPermissions.length > 5) {
          throw new Error(`Too many required permissions in ${documentId}/${sectionSlug}.`);
        }
        continue;
      }
      if (APP_HELP_META_RE.test(rawLine)) {
        throw new Error(`Malformed app-help metadata in ${documentId}/${sectionSlug}.`);
      }
      body.push(rawLine);
    }

    const bodyText = body.join('\n').trim();
    if (!bodyText) throw new Error(`Empty app-help section ${documentId}/${sectionSlug}.`);
    const markdown = `## ${sectionTitle}\n\n${bodyText}`;
    if (markdown.length > MAX_SECTION_CHARS) {
      throw new Error(
        `App-help section ${documentId}/${sectionSlug} exceeds ${MAX_SECTION_CHARS} characters.`,
      );
    }
    out.push({
      documentId,
      sectionId: `${documentId}/${sectionSlug}`,
      documentTitle,
      sectionTitle,
      requiredPermissions,
      markdown,
      aliases,
    });
  }
  return out;
}

interface AppHelpMatchWithAliases extends AppHelpMatch {
  aliases: string[];
}

function indexSection(section: AppHelpMatchWithAliases): IndexedSection {
  const documentNorm = normalize(section.documentTitle);
  const sectionNorm = normalize(section.sectionTitle);
  const aliasNorms = section.aliases.map(normalize);
  const documentKey = meaningfulTokens(section.documentTitle).join(' ');
  const sectionKey = meaningfulTokens(section.sectionTitle).join(' ');
  const aliasKeys = section.aliases.map((alias) => meaningfulTokens(alias).join(' '));
  const bodyTokens = new Set(meaningfulTokens(section.markdown));
  const strongTokens = new Set(
    meaningfulTokens(
      [section.documentTitle, section.sectionTitle, ...section.aliases].join(' '),
    ),
  );
  return {
    ...section,
    documentNorm,
    sectionNorm,
    aliasNorms,
    documentKey,
    sectionKey,
    aliasKeys,
    bodyTokens,
    strongTokens,
  };
}

function scoreSection(
  section: IndexedSection,
  queryTokens: string[],
  phrase: string,
): { section: IndexedSection; score: number } | null {
  let score = 0;
  let phraseMatch = false;
  const strongMatches = new Set<string>();
  const allMatches = new Set<string>();
  const bodyMatches = new Set<string>();

  if (section.sectionNorm.includes(phrase)) {
    score += 80;
    phraseMatch = true;
  }
  if (section.documentNorm.includes(phrase)) {
    score += 60;
    phraseMatch = true;
  }
  for (const alias of section.aliasNorms) {
    if (alias.includes(phrase)) {
      score += 70;
      phraseMatch = true;
      break;
    }
  }

  if (section.sectionKey === phrase) {
    score += 110;
    phraseMatch = true;
  } else if (section.sectionKey.includes(phrase)) {
    score += 85;
    phraseMatch = true;
  }
  if (section.documentKey === phrase) {
    score += 90;
    phraseMatch = true;
  } else if (section.documentKey.includes(phrase)) {
    score += 65;
    phraseMatch = true;
  }
  for (const alias of section.aliasKeys) {
    if (alias === phrase) {
      score += 100;
      phraseMatch = true;
      break;
    }
    if (alias.includes(phrase)) {
      score += 75;
      phraseMatch = true;
      break;
    }
  }

  for (const token of queryTokens) {
    if (section.strongTokens.has(token)) {
      strongMatches.add(token);
      allMatches.add(token);
      score += section.sectionNorm.split(' ').includes(token) ? 16 : 10;
      continue;
    }
    if (section.bodyTokens.has(token)) {
      bodyMatches.add(token);
      allMatches.add(token);
      score += 2;
      continue;
    }
    if (fuzzyStrongMatch(token, section.strongTokens)) {
      strongMatches.add(token);
      allMatches.add(token);
      score += 7;
    }
  }

  const qualified =
    phraseMatch ||
    (queryTokens.length === 1 && strongMatches.size === 1) ||
    (strongMatches.size >= 1 && allMatches.size >= 2) ||
    bodyMatches.size >= 2;
  return qualified ? { section, score } : null;
}

function fuzzyStrongMatch(token: string, candidates: Set<string>): boolean {
  const maxDistance = token.length >= 8 ? 2 : token.length >= 4 ? 1 : 0;
  if (maxDistance === 0) return false;
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - token.length) > maxDistance) continue;
    if (editDistanceWithin(token, candidate, maxDistance)) return true;
  }
  return false;
}

function editDistanceWithin(a: string, b: string, max: number): boolean {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const value = Math.min(
        next[j - 1]! + 1,
        prev[j]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      next.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return false;
    prev = next;
  }
  return prev[b.length]! <= max;
}

function meaningfulTokens(value: string): string[] {
  return [...new Set(normalize(value).split(' ').filter((t) => t && !STOP_WORDS.has(t)))];
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function isUnsupportedLiveStateQuestion(question: string): boolean {
  const q = normalize(question);
  if (
    /\b(docker|container|kubernetes|helm|deployment|deploy|database|sql|environment variable|env var|server administration)\b/.test(
      q,
    )
  ) {
    return true;
  }
  return [
    /\b(any|what|which)\b.*\bintegrations?\b.*\b(configured|active|enabled|connected)\b/,
    /\bwhich integrations? (are|is) (currently )?configured\b/,
    /\bis (our|the) .* integration (active|enabled|working|connected)\b/,
    /^is [a-z0-9 ]+ (active|enabled|working|connected)$/,
    /\bwhy did .*sync .*fail/,
    /\b(current|latest|last)\b.*\b(sync|run|status|configuration)\b/,
    /\b(show|check|inspect) .*\b(last|latest|current)\b.*\b(sync|run|status|configuration)\b/,
  ].some((pattern) => pattern.test(q));
}

function documentIdFor(root: string, file: string): string {
  const rel = relative(root, file).split(sep).join('/').replace(/\.md$/i, '');
  if (
    !rel ||
    rel.split('/').some((segment) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(segment))
  ) {
    throw new Error(`Invalid app-help document path: ${rel || file}`);
  }
  return rel;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    return;
  }
  throw new Error(`App-help path escapes its content directory: ${candidate}`);
}

function cleanTitle(value: string, documentId: string): string {
  const title = value.trim();
  if (!title || title.length > 200) {
    throw new Error(`Invalid app-help title in ${documentId}.`);
  }
  return title;
}

function slugify(value: string): string {
  return normalize(value).replace(/ /g, '-');
}

function splitMetadata(
  value: string,
  kind: string,
  documentId: string,
): string[] {
  const items = value.split('|').map((item) => item.trim());
  if (items.some((item) => !item || item.length > 100)) {
    throw new Error(`Invalid app-help ${kind} metadata in ${documentId}.`);
  }
  return [...new Set(items)];
}
