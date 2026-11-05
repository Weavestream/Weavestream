/**
 * Path selector for Custom API definitions: where in an upstream JSON
 * record a value lives.
 *
 * Grammar: dotted keys with optional integer indexes and quoted keys,
 * for example `data.items`, `system.serial`, `addresses[0].value` and
 * `["odd key"].value`. The empty string selects the root.
 *
 * Hand-written on purpose: no JSONPath/JMESPath library (several have
 * had code-execution bugs), no `eval`/`Function`, and no regular
 * expression built from operator input. Reads own properties only, and
 * `__proto__`, `prototype` and `constructor` are refused as keys.
 */

export type PathPart = string | number;

export const CUSTOM_API_PATH_LIMITS = {
  /** Characters in one path. */
  length: 256,
  /** Keys and indexes in one path. */
  parts: 16,
} as const;

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** A path that does not follow the grammar; the message is fixed text. */
export class CustomApiPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomApiPathError';
  }
}

/** Characters a bare (unquoted) key cannot contain. */
function isBareKeyChar(char: string): boolean {
  return char !== '.' && char !== '[' && char !== ']' && char !== '"' && char.trim() !== '';
}

function addKey(parts: PathPart[], key: string): void {
  if (key === '') throw new CustomApiPathError('A path has an empty key.');
  if (FORBIDDEN_KEYS.has(key)) throw new CustomApiPathError(`"${key}" is not allowed in a path.`);
  parts.push(key);
}

/** Parses a path into its keys and indexes. Throws CustomApiPathError. */
export function parsePath(path: string): PathPart[] {
  if (typeof path !== 'string') throw new CustomApiPathError('A path must be text.');
  if (path.length > CUSTOM_API_PATH_LIMITS.length) {
    throw new CustomApiPathError(`A path has at most ${CUSTOM_API_PATH_LIMITS.length} characters.`);
  }
  const parts: PathPart[] = [];
  let i = 0;
  // True where a key or an index must follow (start, after a dot).
  let expectSegment = true;
  while (i < path.length) {
    const char = path[i]!;
    if (char === '.') {
      if (expectSegment) throw new CustomApiPathError('A path has an empty key.');
      expectSegment = true;
      i += 1;
      continue;
    }
    if (char === '[') {
      if (expectSegment && parts.length > 0) throw new CustomApiPathError('A dot must be followed by a key, not [.');
      if (path[i + 1] === '"') {
        // Quoted key: ["any text"], with \" and \\ escapes.
        let key = '';
        let j = i + 2;
        let closed = false;
        while (j < path.length) {
          const c = path[j]!;
          if (c === '\\') {
            const next = path[j + 1];
            if (next !== '"' && next !== '\\') throw new CustomApiPathError('A quoted key has an unknown escape.');
            key += next;
            j += 2;
            continue;
          }
          if (c === '"') {
            closed = true;
            break;
          }
          key += c;
          j += 1;
        }
        if (!closed || path[j + 1] !== ']') throw new CustomApiPathError('A quoted key is not closed with "].');
        addKey(parts, key);
        i = j + 2;
      } else {
        let j = i + 1;
        let digits = '';
        while (j < path.length && path[j]! >= '0' && path[j]! <= '9') {
          digits += path[j];
          j += 1;
        }
        if (digits === '' || path[j] !== ']') throw new CustomApiPathError('An index must be a whole number in [ ].');
        if (digits.length > 6) throw new CustomApiPathError('An index is too large.');
        parts.push(Number(digits));
        i = j + 1;
      }
      expectSegment = false;
      const after = path[i];
      if (after !== undefined && after !== '.' && after !== '[') {
        throw new CustomApiPathError('After ] a path continues with . or [.');
      }
    } else {
      if (!expectSegment) throw new CustomApiPathError('Keys in a path are separated by dots.');
      let key = '';
      while (i < path.length && isBareKeyChar(path[i]!)) {
        key += path[i];
        i += 1;
      }
      if (key === '') throw new CustomApiPathError('A path has a character that needs a quoted key, for example ["my key"].');
      addKey(parts, key);
      expectSegment = false;
    }
    if (parts.length > CUSTOM_API_PATH_LIMITS.parts) {
      throw new CustomApiPathError(`A path has at most ${CUSTOM_API_PATH_LIMITS.parts} parts.`);
    }
  }
  if (path.length > 0 && expectSegment) throw new CustomApiPathError('A path cannot end with a dot.');
  return parts;
}

/** True when the path parses. */
export function isValidPath(path: string): boolean {
  try {
    parsePath(path);
    return true;
  } catch {
    // The parse error is the answer here, not a failure.
    return false;
  }
}

export type PathResult =
  | { kind: 'value'; value: string | number | boolean }
  | { kind: 'missing' }
  | { kind: 'not_scalar' };

/** Follows parsed parts through own properties and array indexes; undefined when any step is absent. */
export function resolvePath(root: unknown, parts: readonly PathPart[]): unknown {
  let current: unknown = root;
  for (const part of parts) {
    if (typeof part === 'number') {
      if (!Array.isArray(current) || part >= current.length) return undefined;
      current = current[part];
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
      if (FORBIDDEN_KEYS.has(part) || !Object.hasOwn(current, part)) return undefined;
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

/**
 * The single value at `parts`. A missing value (absent or null) is
 * `missing`; an object or array is `not_scalar`.
 */
export function readPath(root: unknown, parts: readonly PathPart[]): PathResult {
  const value = resolvePath(root, parts);
  if (value === undefined || value === null) return { kind: 'missing' };
  if (typeof value === 'string' || typeof value === 'boolean') return { kind: 'value', value };
  if (typeof value === 'number') return Number.isFinite(value) ? { kind: 'value', value } : { kind: 'missing' };
  return { kind: 'not_scalar' };
}

const BARE_KEY_FOR_FORMAT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

/** The text form of parsed parts; `parsePath(formatPath(p))` gives `p` back. */
export function formatPath(parts: readonly PathPart[]): string {
  let out = '';
  for (const part of parts) {
    if (typeof part === 'number') out += `[${part}]`;
    else if (BARE_KEY_FOR_FORMAT.test(part)) out += out === '' ? part : `.${part}`;
    else out += `["${part.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`;
  }
  return out;
}

export type ScalarType = 'string' | 'number' | 'boolean' | 'null';

export interface ScalarPathEntry {
  parts: PathPart[];
  path: string;
  type: ScalarType;
  value: string | number | boolean | null;
}

/**
 * Every single value inside `root`, depth first in key order, for the
 * Test key list. Stops at `maxEntries` entries and at `maxDepth` levels;
 * keys that no path may name, or that are too long, are skipped.
 */
export function listScalarPaths(
  root: unknown,
  opts: { maxEntries: number; maxDepth?: number },
): ScalarPathEntry[] {
  const out: ScalarPathEntry[] = [];
  const maxDepth = Math.min(opts.maxDepth ?? CUSTOM_API_PATH_LIMITS.parts, CUSTOM_API_PATH_LIMITS.parts);
  const visit = (value: unknown, parts: PathPart[]): void => {
    if (out.length >= opts.maxEntries) return;
    if (value === null || typeof value !== 'object') {
      if (parts.length === 0) return;
      const type: ScalarType | null = value === null
        ? 'null'
        : typeof value === 'string' ? 'string'
          : typeof value === 'number' ? 'number'
            : typeof value === 'boolean' ? 'boolean' : null;
      if (type === null) return;
      const path = formatPath(parts);
      if (path.length > CUSTOM_API_PATH_LIMITS.length) return;
      out.push({ parts, path, type, value: value as string | number | boolean | null });
      return;
    }
    if (parts.length >= maxDepth) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length && out.length < opts.maxEntries; index += 1) {
        visit(value[index], [...parts, index]);
      }
      return;
    }
    for (const key of Object.keys(value)) {
      if (out.length >= opts.maxEntries) return;
      if (FORBIDDEN_KEYS.has(key) || key === '') continue;
      visit((value as Record<string, unknown>)[key], [...parts, key]);
    }
  };
  visit(root, []);
  return out;
}
