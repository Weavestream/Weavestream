import {
  PASSWORD_GENERATOR_SEPARATOR_CHARS,
  type PasswordGeneratorDefaults,
  type PasswordGeneratorPreset,
} from '../schemas/password-generator.js';
import { getWordBucket } from './wordlist.js';

/**
 * Phase 10 — client-side passphrase generator.
 *
 * The generator is a pure function that consumes `window.crypto` as its
 * source of randomness and returns a single passphrase string. All
 * three workspace presets share the same knob schema — `preset` only
 * influences which EFF word-length bucket we draw from (and, for
 * `read`, a post-filter that strips any word containing a letter that
 * reads ambiguously when typed in mixed case or next to a digit).
 *
 * No network round-trip, no telemetry, and no persistent storage
 * touches the plaintext. The only way the generated string leaves the
 * function is the return value, and callers (the popover + the admin
 * preview) pipe it straight into a local React state without ever
 * writing it to disk, cookies, or the API.
 */

const AMBIGUOUS_CHARS = new Set(['0', 'O', 'o', '1', 'l', 'I', 'i']);

/**
 * Unbiased uniform integer in [0, max) using `crypto.getRandomValues`.
 * Rejection sampling avoids the modulo-bias trap where the largest few
 * buckets of the uint32 range are slightly over-represented. This
 * matters for a credential generator: biased word picks would leak
 * tiny amounts of entropy over a corpus of generated passphrases.
 */
function randInt(max: number): number {
  if (max <= 0) throw new RangeError('randInt: max must be > 0');
  const range = Math.floor(0x1_0000_0000 / max) * max;
  const buf = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(buf);
    if (buf[0]! < range) return buf[0]! % max;
  }
}

function pickWord(pool: readonly string[]): string {
  return pool[randInt(pool.length)]!;
}

function titleCase(word: string): string {
  if (word.length === 0) return word;
  return word[0]!.toUpperCase() + word.slice(1).toLowerCase();
}

function bucketFor(preset: PasswordGeneratorPreset): readonly string[] {
  if (preset === 'remember') return getWordBucket(4);
  return getWordBucket(5);
}

function containsAmbiguous(s: string): boolean {
  for (const c of s) if (AMBIGUOUS_CHARS.has(c)) return true;
  return false;
}

/**
 * Generate a passphrase matching `opts`. The knobs are interpreted as:
 *
 *   - `preset`       — picks the word pool (shorter words for `remember`).
 *   - `words`        — minimum number of words in the phrase.
 *   - `length`       — minimum total character length. If the words+sep
 *                      total falls short we keep appending extra words
 *                      until we clear the floor. That keeps a single
 *                      knob schema across all three presets without
 *                      needing a separate "random characters" mode.
 *   - `separator`    — mapped to a char via PASSWORD_GENERATOR_SEPARATOR_CHARS.
 *   - `alternateCase`— Title-Cases every word.
 *   - `includeNumber`— appends a single 1-99 digit onto one randomly
 *                      chosen word before joining.
 *
 * For `read` we retry the whole phrase (up to 8 attempts) if it ends up
 * containing any ambiguous character (`0/O/1/l/I`); after 8 attempts we
 * accept whatever we have so the function always terminates.
 */
export function generatePassword(opts: PasswordGeneratorDefaults): string {
  const maxAttempts = opts.preset === 'read' ? 8 : 1;
  let last = '';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    last = buildPhrase(opts);
    if (opts.preset !== 'read') return last;
    if (!containsAmbiguous(last)) return last;
  }
  return last;
}

function buildPhrase(opts: PasswordGeneratorDefaults): string {
  const pool = bucketFor(opts.preset);
  const sep = PASSWORD_GENERATOR_SEPARATOR_CHARS[opts.separator];
  const minWords = Math.max(2, opts.words);
  const minLen = Math.max(8, opts.length);

  let words: string[] = [];
  for (let i = 0; i < minWords; i += 1) {
    words.push(pickWord(pool));
  }

  if (opts.alternateCase) {
    words = words.map(titleCase);
  }

  // Pick a word to host the trailing digits. We append rather than
  // insert between words so the separator stays purely a separator,
  // which keeps "easier to say" passphrases pronounceable.
  let digitHost: number | null = null;
  let digits = '';
  if (opts.includeNumber) {
    digitHost = randInt(words.length);
    digits = String(randInt(99) + 1);
    words[digitHost] = words[digitHost]! + digits;
  }

  // Top up until we clear the minimum character length floor. Added
  // words follow the same casing & digit rules as the initial batch.
  let phrase = words.join(sep);
  let safety = 32;
  while (phrase.length < minLen && safety > 0) {
    let extra = pickWord(pool);
    if (opts.alternateCase) extra = titleCase(extra);
    words.push(extra);
    phrase = words.join(sep);
    safety -= 1;
  }

  return phrase;
}
