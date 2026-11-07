const sensitiveKeyPattern =
  /(secret|password|passwd|passphrase|token|apikey|authorization|credential|privatekey|encryptionkey|providerconfig|recoverykey|rawpayload|rawbody|rawrequest|rawresponse)/;

const sensitiveValuePatterns = [
  /\b(?:bearer|basic)\s+\S{8,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /(?:^|[?&;\s])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)=\S+/i,
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /\b(?:gh[pousr]_|xox[baprs]-|sk-(?:live-|test-)?)[A-Za-z0-9_-]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
];

const MAX_SCAN_DEPTH = 8;
const MAX_SCAN_ENTRIES = 1_024;

export type SensitiveMaterialScan = 'safe' | 'sensitive' | 'bounds_exceeded';

export function scanSensitiveMaterial(root: unknown): SensitiveMaterialScan {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let entries = 0;

  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current.depth > MAX_SCAN_DEPTH) return 'bounds_exceeded';
      if (typeof current.value === 'string') {
        const text = current.value;
        if (sensitiveValuePatterns.some((pattern) => pattern.test(text)) || looksHighEntropy(text)) {
          return 'sensitive';
        }
        continue;
      }
      if (!current.value || typeof current.value !== 'object') continue;
      if (seen.has(current.value)) return 'bounds_exceeded';
      seen.add(current.value);

      if (Array.isArray(current.value)) {
        const length = current.value.length;
        entries += length;
        if (entries > MAX_SCAN_ENTRIES) return 'bounds_exceeded';
        for (let index = 0; index < length; index += 1) {
          if (index in current.value) {
            pending.push({ value: current.value[index], depth: current.depth + 1 });
          }
        }
        continue;
      }

      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        entries += 1;
        if (entries > MAX_SCAN_ENTRIES) return 'bounds_exceeded';
        const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
        if (sensitiveKeyPattern.test(normalized)) return 'sensitive';
        pending.push({
          value: (current.value as Record<string, unknown>)[key],
          depth: current.depth + 1,
        });
      }
    }
  } catch {
    return 'bounds_exceeded';
  }
  return 'safe';
}

/**
 * True for a property name that names a credential (`password`,
 * `apiToken`, `client_secret`, ...), with the same normalization the scan
 * applies to keys. For a value read out of its object (a Test sample), so
 * the key context is not lost.
 */
export function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
}

export function containsSensitiveMaterial(value: unknown): boolean {
  return scanSensitiveMaterial(value) !== 'safe';
}

// A canonical UUID is an identifier, not a credential. Weavestream builds
// slugs and external ids from source UUIDs (`automations-<uuid>`), and with
// the hyphens joined to a prefix such a run can clear the entropy bar by
// chance. The Breeze desired-configuration inspection exempts UUIDs the same
// way. Explicit secret patterns above still apply to the whole value.
const UUID_SUBSTRING_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;

/** What a redacted value or span is replaced with. */
export const WITHHELD_PLACEHOLDER = '[withheld]';

// Words that name a credential, for names in source data (`adminPassword`,
// `api_key`, `DB_PASSWORD`, `BitLockerRecoveryKey`).
const CREDENTIAL_NAME_WORDS: ReadonlySet<string> = new Set([
  'authorization', 'credential', 'credentials', 'encryptionkey', 'apikey', 'accesstoken',
  'refreshtoken', 'privatekey', 'providerconfig', 'password', 'passwd', 'passphrase', 'pwd', 'secret',
  'token', 'recoverykey', 'bitlockerrecoverykey', 'clientsecret', 'psk',
]);
// A name that ends in `key` names a credential when a word before it says
// which kind: `secretAccessKey`, `privateKey`, `ssh_key`. `accessKeyId` or
// `keyName` does not end in `key`, and `registryKey` names no credential.
const CREDENTIAL_KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  'secret', 'access', 'private', 'api', 'encryption', 'recovery', 'signing', 'ssh', 'shared', 'preshared',
]);

function credentialNameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .split(/[^A-Za-z0-9]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * True for a name that names a credential. `last` (for structured keys):
 * the last word or the whole compacted name must be a credential word, so
 * `adminPassword` and `api_key` match and a setting about a credential
 * (`passwordMinLength`, `tokenExpiry`) does not. `any` (for assignments in
 * text, where only the assigned value is redacted): any word counts.
 */
export function isCredentialName(name: string, mode: 'last' | 'any' = 'last'): boolean {
  const words = credentialNameWords(name);
  if (words.length === 0) return false;
  if (CREDENTIAL_NAME_WORDS.has(words.join(''))) return true;
  const last = words.at(-1)!;
  if ((last === 'key' || last === 'keys') && words.slice(0, -1).some((word) => CREDENTIAL_KEY_QUALIFIERS.has(word))) {
    return true;
  }
  return mode === 'any'
    ? words.some((word) => CREDENTIAL_NAME_WORDS.has(word))
    : CREDENTIAL_NAME_WORDS.has(words.at(-1)!);
}

// Span forms of the value patterns above, for redaction. Each replacement
// leaves text the scan no longer matches (`Bearer [withheld]` would still
// match the bearer pattern, so the whole span goes). A URL keeps its scheme
// and host and loses only the user-info part.
const redactionRules: ReadonlyArray<readonly [RegExp, string]> = [
  [/-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]*?(?:-----END \1PRIVATE KEY-----|$)/gi, WITHHELD_PLACEHOLDER],
  [/\b(?:bearer|basic)\s+\S{8,}/gi, WITHHELD_PLACEHOLDER],
  [/(^|[?&;\s])(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization)=\S+/gi, `$1${WITHHELD_PLACEHOLDER}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${WITHHELD_PLACEHOLDER}@`],
  [/\b(?:gh[pousr]_|xox[baprs]-|sk-(?:live-|test-)?)[A-Za-z0-9_-]{16,}\b/gi, WITHHELD_PLACEHOLDER],
  [/\bAKIA[0-9A-Z]{16}\b/g, WITHHELD_PLACEHOLDER],
  // Google API key: a fixed prefix and 35 URL-safe characters (redaction
  // only; the scan does not flag it, so other drivers are unchanged).
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, WITHHELD_PLACEHOLDER],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, WITHHELD_PLACEHOLDER],
];

// A quoted value ends at its real closing quote, not at an escaped one, so
// no part of a quoted secret is left after the placeholder. Text does not
// say which language it is, and the languages disagree on the backslash:
// - literal reading (PowerShell, Bash single quotes): a backslash is a plain
//   character; quotes escape by doubling (`'a''b'`, `"a""b"`) or, in
//   PowerShell double quotes, with a backtick ("a`"b");
// - escape reading (Bash double quotes, JSON, JS, Python): a backslash
//   escapes the next character (`"a\"b"`, `'a\'b'`).
// Both readings accept doubled quotes and the Bash splice `'a'\''b'`. Each
// reading scans the text on its own, and every span either one withholds is
// withheld, so `$Password = 'a\'; $Token = 'b'` (two values in PowerShell,
// one in Python) loses both values. Each body has one way to read each
// character, so matching stays linear.
const LITERAL_SINGLE = String.raw`'(?:[^'\r\n]|'')*'(?:\\''(?:[^'\r\n]|'')*')*`;
const LITERAL_DOUBLE = String.raw`"(?:[^"\x60\r\n]|\x60[^\r\n]|"")*"`;
const ESCAPE_SINGLE = String.raw`'(?:[^'\\\r\n]|\\[^\r\n]|'')*'(?:\\''(?:[^'\\\r\n]|\\[^\r\n]|'')*')*`;
const ESCAPE_DOUBLE = String.raw`"(?:[^"\\\r\n]|\\[^\r\n]|"")*"`;

interface CredentialPatterns {
  /** `NAME = value`, `"NAME": "value"`, `$env:NAME='value'`, `set "NAME=value"`. */
  readonly assignment: RegExp;
  /** `setx [/M] NAME value`. */
  readonly setx: RegExp;
  /**
   * `--password value`, `--password=value`, `-ApiKey:'value'`, and the cmd
   * form `/password:value`. A `/name` flag needs `=` or `:`, so a path such
   * as `/secret file` is left alone. After a space, a bare value never
   * starts with `-` or `/`: that is the next flag (`/install /password:x`),
   * so it stays checkable. After `=` or `:`, any value counts (`--password=-x`).
   */
  readonly flag: RegExp;
  /** `ConvertTo-SecureString 'value' -AsPlainText` in either order. */
  readonly secureString: RegExp;
}

function credentialPatterns(quoted: string): CredentialPatterns {
  return {
    assignment: new RegExp(
      `(^|[^A-Za-z0-9_$.-])(["']?\\$?(?:env:)?)([A-Za-z_][A-Za-z0-9_.-]{0,127})(["']?\\s*)(=|:)(\\s*)(${quoted}|[^\\s"'$%(\\[{@;,}\\]][^\\s"';,}\\]]*)`,
      'gu',
    ),
    setx: new RegExp(
      `(\\bsetx(?:\\s+\\/M)?\\s+["']?)([A-Za-z_][A-Za-z0-9_-]{0,127})(["']?\\s+)(${quoted}|[^\\s"';]+)`,
      'giu',
    ),
    flag: new RegExp(
      `((?:^|\\s)(?:--?|\\/))([A-Za-z][A-Za-z0-9_-]{0,127})(\\s+|[=:])(${quoted}|(?<=[=:])[^\\s"']+|[^\\s"'/-][^\\s"']*)`,
      'gu',
    ),
    secureString: new RegExp(
      `(\\bConvertTo-SecureString\\b[^\\r\\n|;]*?)(${quoted}|(?<=-String\\s+)[^\\s"'-]\\S*|(?<=ConvertTo-SecureString\\s+)[^\\s"'-]\\S*)`,
      'giu',
    ),
  };
}

const QUOTE_READINGS: readonly CredentialPatterns[] = [
  credentialPatterns(`${LITERAL_DOUBLE}|${LITERAL_SINGLE}`),
  credentialPatterns(`${ESCAPE_DOUBLE}|${ESCAPE_SINGLE}`),
];

// A flag value that is a variable or an expression, not a literal secret.
const FLAG_REFERENCE_VALUE = /^[$%([{@<]/u;
// Plain words that follow a flag name in usage text ("--password without a
// value"). A password that is one of these words protects nothing.
const FLAG_PROSE_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'as', 'flag', 'for', 'from', 'if', 'in', 'is', 'not', 'of', 'on', 'option', 'or',
  'parameter', 'switch', 'the', 'to', 'when', 'with', 'without',
]);

function quotedPlaceholder(value: string): string {
  const quote = value.startsWith('"') || value.startsWith("'") ? value[0]! : '';
  return `${quote}${WITHHELD_PLACEHOLDER}${quote}`;
}

function isBlankLiteral(value: string): boolean {
  return /^(?:""|'')$/u.test(value) || value === WITHHELD_PLACEHOLDER || value === `"${WITHHELD_PLACEHOLDER}"`
    || value === `'${WITHHELD_PLACEHOLDER}'`;
}

type Span = readonly [start: number, end: number];

/** The value is the last group of every credential pattern, so it ends the match. */
function valueSpan(match: RegExpMatchArray, value: string): Span {
  const end = match.index! + match[0].length;
  return [end - value.length, end];
}

/** The credential values one quote reading finds in `text`. */
function credentialValueSpans(text: string, patterns: CredentialPatterns): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(patterns.assignment)) {
    const name = match[3]!, close = match[4]!, op = match[5]!, gap = match[6]!, value = match[7]!;
    if (!isCredentialName(name, 'any') || isBlankLiteral(value)) continue;
    const quoted = /^["']/u.test(value);
    // A number assigned to a credential name is a literal secret, also
    // with spaces (`$Password = 123456`). `$PasswordLength = 12` is a
    // setting: the name must end in a credential word.
    const spacedNumber = !quoted && op === '=' && /^\d+$/u.test(value) && isCredentialName(name, 'last');
    // `Password: must be 12 characters` is prose and `$Password = Read-Host`
    // is a command: an unquoted value counts only in `NAME=value` form.
    if (!quoted && !spacedNumber && (op === ':' || /\s/u.test(close + gap))) continue;
    // `passwordMinLength=12` is a setting about a credential.
    if (!quoted && /^\d+$/u.test(value) && !isCredentialName(name, 'last')) continue;
    spans.push(valueSpan(match, value));
  }
  for (const match of text.matchAll(patterns.setx)) {
    const name = match[2]!, value = match[4]!;
    if (isCredentialName(name, 'any') && !isBlankLiteral(value)) spans.push(valueSpan(match, value));
  }
  for (const match of text.matchAll(patterns.flag)) {
    const lead = match[1]!, name = match[2]!, gap = match[3]!, value = match[4]!;
    if (!isCredentialName(name, 'last') || isBlankLiteral(value)) continue;
    if (lead.endsWith('/') && /^\s/u.test(gap)) continue;
    if (!/^["']/u.test(value)) {
      if (FLAG_REFERENCE_VALUE.test(value)) continue;
      // Usage text: a plain word, maybe ending a sentence ("--password and.").
      const word = value.replace(/[.,;:!?)]+$/u, '').toLowerCase();
      if (/\s/u.test(gap) && FLAG_PROSE_WORDS.has(word)) continue;
    }
    spans.push(valueSpan(match, value));
  }
  for (const match of text.matchAll(patterns.secureString)) {
    const value = match[2]!;
    const line = text.slice(match.index).split(/[\r\n]/u)[0] ?? '';
    if (!/(?:^|\s)-AsPlainText(?:\s|$)/iu.test(line) || isBlankLiteral(value)) continue;
    spans.push(valueSpan(match, value));
  }
  return spans;
}

/**
 * Plain-text credential assignments the format rules cannot see because the
 * value itself looks ordinary (`$Password = 'Summer2026!'`). Only the value
 * of an assignment to a credential-named variable, setting, or flag is
 * replaced; the name and the rest of the text stay. Overlapping spans from
 * the two quote readings become one placeholder.
 */
function redactCredentialAssignments(text: string): string {
  const spans = QUOTE_READINGS.flatMap((patterns) => credentialValueSpans(text, patterns))
    .sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let output = '';
  let position = 0;
  for (const [start, end] of merged) {
    output += text.slice(position, start) + quotedPlaceholder(text.slice(start, end));
    position = end;
  }
  return output + text.slice(position);
}

export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  let output = redactCredentialAssignments(text);
  for (const [pattern, replacement] of redactionRules) {
    output = output.replace(pattern, replacement);
  }
  // UUIDs are blanked with spaces of the same length, so the positions of
  // the runs found in `blanked` are the same in `output`.
  const blanked = output.replace(UUID_SUBSTRING_PATTERN, (uuid) => ' '.repeat(uuid.length));
  const spans: Array<[number, number]> = [];
  for (const match of blanked.matchAll(/[A-Za-z0-9+/_=-]+/g)) {
    if (isHighEntropyToken(match[0])) spans.push([match.index, match.index + match[0].length]);
  }
  for (const [start, end] of spans.reverse()) {
    output = output.slice(0, start) + WITHHELD_PLACEHOLDER + output.slice(end);
  }
  if (output !== text && scanSensitiveMaterial(output) !== 'safe') {
    return { text: WITHHELD_PLACEHOLDER, redacted: true };
  }
  if (output === text && scanSensitiveMaterial(output) === 'sensitive') {
    return { text: WITHHELD_PLACEHOLDER, redacted: true };
  }
  return { text: output, redacted: output !== text };
}

function looksHighEntropy(value: string): boolean {
  // Inspect every maximal token-shaped run instead of the whole string. A
  // high-entropy secret concatenated into surrounding text — e.g. through a
  // `join` or markdown_table separator — must not be laundered by neighbouring
  // whitespace or punctuation that breaks the run apart. Runs outside the
  // 40–4096 length window are ignored, so large legitimate base64 payloads and
  // short identifiers stay safe exactly as before.
  const runs = value.replace(UUID_SUBSTRING_PATTERN, ' ').match(/[A-Za-z0-9+/_=-]+/g);
  return runs !== null && runs.some(isHighEntropyToken);
}

function isHighEntropyToken(candidate: string): boolean {
  if (candidate.length < 40 || candidate.length > 4096) return false;
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
