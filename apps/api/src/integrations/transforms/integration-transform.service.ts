import { Injectable } from '@nestjs/common';
import {
  integrationTransformSchema,
  ipv4HostSchema,
  normalizeCidrV4,
  type IntegrationTransform,
  type IntegrationTransformStep,
} from '@weavestream/shared';

const MAX_INPUT_BYTES = 262_144;
const MAX_DEPTH = 8;
const MAX_ENTRIES = 1_024;
const MAX_OUTPUT_BYTES = 65_536;

export type IntegrationTransformErrorCode =
  | 'INVALID_DESCRIPTOR'
  | 'INPUT_TOO_LARGE'
  | 'INPUT_TOO_DEEP'
  | 'INPUT_TOO_COMPLEX'
  | 'RECURSIVE_INPUT'
  | 'INVALID_INPUT'
  | 'INVALID_STRING'
  | 'INVALID_NUMBER'
  | 'INVALID_BOOLEAN'
  | 'INVALID_DATE'
  | 'UNSUPPORTED_DATE_FORMAT'
  | 'ENUM_VALUE_NOT_FOUND'
  | 'INVALID_PATH'
  | 'INVALID_JOIN_VALUE'
  | 'INVALID_BYTES'
  | 'INVALID_CIDR'
  | 'INVALID_IP'
  | 'INVALID_TABLE'
  | 'TOO_MANY_TABLE_ROWS'
  | 'OUTPUT_TOO_LARGE'
  | 'SECRET_OUTPUT';

export class IntegrationTransformError extends Error {
  constructor(
    readonly code: IntegrationTransformErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationTransformError';
  }
}

@Injectable()
export class IntegrationTransformService {
  execute(value: unknown, descriptor: IntegrationTransform, root: unknown = value): unknown {
    const parsed = integrationTransformSchema.safeParse(descriptor);
    if (!parsed.success) {
      throw new IntegrationTransformError(
        'INVALID_DESCRIPTOR',
        'Transform descriptor is invalid.',
      );
    }
    if (
      Array.isArray(value) &&
      value.length > 1_000 &&
      parsed.data.steps.some((step) => step.op === 'markdown_table')
    ) {
      throw new IntegrationTransformError(
        'TOO_MANY_TABLE_ROWS',
        'Markdown table input exceeds 1000 rows.',
      );
    }

    assertInputBounds(root);
    if (root !== value) assertInputBounds(value);

    let current = value;
    for (const step of parsed.data.steps) {
      current = applyStep(current, step, root);
      assertOutputBounds(current);
    }
    if (containsSecretLikeMaterial(current)) {
      throw new IntegrationTransformError(
        'SECRET_OUTPUT',
        'Transform output contains sensitive material.',
      );
    }
    return current;
  }
}

function applyStep(value: unknown, step: IntegrationTransformStep, root: unknown): unknown {
  switch (step.op) {
    case 'trim':
      return requireString(value).trim();
    case 'lowercase':
      return requireString(value).toLowerCase();
    case 'uppercase':
      return requireString(value).toUpperCase();
    case 'to_number':
      return toNumber(value);
    case 'to_boolean':
      return toBoolean(value, step.truthy, step.falsy);
    case 'to_date':
      return toDate(value, step.format);
    case 'enum_lookup': {
      const key = String(value);
      if (Object.prototype.hasOwnProperty.call(step.mapping, key)) return step.mapping[key];
      if (step.fallback !== undefined) return step.fallback;
      throw new IntegrationTransformError(
        'ENUM_VALUE_NOT_FOUND',
        'Transform enum value is not mapped.',
      );
    }
    case 'first_nonempty':
      for (const path of step.paths) {
        const candidate = resolvePath(root, path);
        if (isNonempty(candidate)) return candidate;
      }
      return null;
    case 'join':
      return step.paths
        .map((path) => stringifyScalar(resolvePath(root, path)))
        .join(step.separator);
    case 'format_bytes':
      return formatBytes(value, step.precision ?? 2);
    case 'normalize_cidr': {
      const cidr = typeof value === 'string' ? normalizeCidrV4(value) : null;
      if (!cidr) {
        throw new IntegrationTransformError('INVALID_CIDR', 'Transform value is not a valid IPv4 CIDR.');
      }
      return cidr;
    }
    case 'normalize_ip': {
      const parsed = ipv4HostSchema.safeParse(value);
      if (!parsed.success) {
        throw new IntegrationTransformError('INVALID_IP', 'Transform value is not a valid IPv4 address.');
      }
      return parsed.data;
    }
    case 'markdown_table':
      return markdownTable(value, step.columns);
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new IntegrationTransformError('INVALID_STRING', 'Transform value must be a string.');
  }
  return value;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new IntegrationTransformError('INVALID_NUMBER', 'Transform value is not a finite number.');
  }
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    throw new IntegrationTransformError('INVALID_NUMBER', 'Transform value is not a finite number.');
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new IntegrationTransformError('INVALID_NUMBER', 'Transform value is not a finite number.');
  }
  return parsed;
}

function toBoolean(value: unknown, truthy?: string[], falsy?: string[]): boolean {
  if (typeof value === 'boolean') return value;
  const candidate = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  if (truthy || falsy) {
    if (truthy?.includes(candidate)) return true;
    if (falsy?.includes(candidate)) return false;
  } else {
    const normalized = candidate.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  throw new IntegrationTransformError('INVALID_BOOLEAN', 'Transform value is not a recognized boolean.');
}

function toDate(value: unknown, format?: string): string {
  if (format?.trim()) {
    throw new IntegrationTransformError(
      'UNSUPPORTED_DATE_FORMAT',
      'Custom date formats are not supported.',
    );
  }
  let date: Date;
  if (value instanceof Date) date = new Date(value.getTime());
  else if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value);
  else if (typeof value === 'string' && isStrictIsoDate(value.trim())) {
    date = new Date(value.trim());
  }
  else {
    throw new IntegrationTransformError('INVALID_DATE', 'Transform value is not a valid date.');
  }
  if (!Number.isFinite(date.getTime())) {
    throw new IntegrationTransformError('INVALID_DATE', 'Transform value is not a valid date.');
  }
  return date.toISOString();
}

function isStrictIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2})))?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > lastDay) return false;
  if (match[4] === undefined) return true;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59;
}

function resolvePath(root: unknown, path: string): unknown {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path)) {
    throw new IntegrationTransformError('INVALID_PATH', 'Transform path is invalid.');
  }
  let current = root;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isNonempty(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

function stringifyScalar(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new IntegrationTransformError('INVALID_JOIN_VALUE', 'Join paths must resolve to safe scalar values.');
    }
    return String(value);
  }
  throw new IntegrationTransformError('INVALID_JOIN_VALUE', 'Join paths must resolve to safe scalar values.');
}

function formatBytes(value: unknown, precision: number): string {
  const bytes = toNumber(value);
  if (bytes < 0) {
    throw new IntegrationTransformError('INVALID_BYTES', 'Byte count must be nonnegative.');
  }
  if (bytes === 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const scaled = bytes / 1024 ** exponent;
  return exponent === 0 ? `${scaled.toFixed(0)} B` : `${scaled.toFixed(precision)} ${units[exponent]}`;
}

function markdownTable(
  value: unknown,
  columns: Array<{ header: string; path: string }>,
): string {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new IntegrationTransformError('INVALID_TABLE', 'Markdown table input must be an array of objects.');
  }
  if (value.length > 1_000) {
    throw new IntegrationTransformError('TOO_MANY_TABLE_ROWS', 'Markdown table input exceeds 1000 rows.');
  }
  const header = `| ${columns.map((column) => escapeMarkdownCell(column.header)).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const rows = value.map((row) => {
    const cells = columns.map((column) => {
      const resolved = resolvePath(row, column.path);
      return escapeMarkdownCell(stringifyScalar(resolved));
    });
    return `| ${cells.join(' | ')} |`;
  });
  return [header, separator, ...rows].join('\n');
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
}

function assertInputBounds(value: unknown): void {
  let measured: ReturnType<typeof measureValue>;
  try {
    measured = measureValue(value);
  } catch (error) {
    if (error instanceof IntegrationTransformError) throw error;
    throw new IntegrationTransformError('INVALID_INPUT', 'Transform input must be finite JSON.');
  }
  if (measured.bytes > MAX_INPUT_BYTES) {
    throw new IntegrationTransformError('INPUT_TOO_LARGE', 'Transform input exceeds 262144 UTF-8 bytes.');
  }
  if (measured.depth > MAX_DEPTH) {
    throw new IntegrationTransformError('INPUT_TOO_DEEP', 'Transform input exceeds 8 nesting levels.');
  }
  if (measured.entries > MAX_ENTRIES) {
    throw new IntegrationTransformError('INPUT_TOO_COMPLEX', 'Transform input exceeds 1024 entries.');
  }
}

function assertOutputBounds(value: unknown): void {
  let bytes: number;
  try {
    bytes = measureValue(value).bytes;
  } catch {
    throw new IntegrationTransformError('INVALID_INPUT', 'Transform output must be finite JSON.');
  }
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new IntegrationTransformError('OUTPUT_TOO_LARGE', 'Transform output exceeds 65536 UTF-8 bytes.');
  }
}

function measureValue(value: unknown): { bytes: number; depth: number; entries: number } {
  const seen = new Set<object>();
  let depth = 0;
  let entries = 0;
  const visit = (entry: unknown, level: number): void => {
    depth = Math.max(depth, level);
    if (entry === undefined || typeof entry === 'bigint' || typeof entry === 'function' || typeof entry === 'symbol') {
      throw new Error('not JSON');
    }
    if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('not finite');
    if (!entry || typeof entry !== 'object' || entry instanceof Date) return;
    if (seen.has(entry)) {
      throw new IntegrationTransformError('RECURSIVE_INPUT', 'Transform input must not be recursive.');
    }
    seen.add(entry);
    const children = Array.isArray(entry) ? entry : Object.values(entry as Record<string, unknown>);
    entries += children.length;
    for (const child of children) visit(child, level + 1);
    seen.delete(entry);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error('not JSON');
  return { bytes: Buffer.byteLength(json, 'utf8'), depth, entries };
}

const secretKeyPattern =
  /(secret|password|passwd|passphrase|token|apikey|authorization|credential|privatekey|encryptionkey|providerconfig|recoverykey)/;
const explicitSecretPatterns = [
  /\b(?:bearer|basic)\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:^|[?&;\s])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)=\S+/i,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:gh[pousr]_|xox[baprs]-|sk-(?:live-|test-)?)[A-Za-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

function containsSecretLikeMaterial(value: unknown): boolean {
  if (typeof value === 'string') {
    return explicitSecretPatterns.some((pattern) => pattern.test(value)) || looksHighEntropy(value);
  }
  if (Array.isArray(value)) return value.some(containsSecretLikeMaterial);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, entry]) => {
      const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
      return secretKeyPattern.test(normalized) || containsSecretLikeMaterial(entry);
    });
  }
  return false;
}

function looksHighEntropy(value: string): boolean {
  const candidate = value.trim();
  if (candidate.length < 40 || candidate.length > 4096 || /\s/.test(candidate)) return false;
  if (!/^[A-Za-z0-9+/_=-]+$/.test(candidate)) return false;
  const counts = new Map<string, number>();
  for (const char of candidate) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / candidate.length;
    entropy -= probability * Math.log2(probability);
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/_=-]/].filter((pattern) => pattern.test(candidate)).length;
  return classes >= 3 && entropy >= 4.25;
}
