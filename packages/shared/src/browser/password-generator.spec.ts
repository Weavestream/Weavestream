import { generatePassword } from './password-generator';
import { getWordBucket } from './wordlist';
import type { PasswordGeneratorDefaults } from '../schemas/password-generator';

/**
 * Runs in the default node environment: the generator reads only
 * `crypto.getRandomValues`, which Node's webcrypto provides globally.
 * For determinism every test installs a scripted sequence of uint32s.
 *
 * `randInt(max)` maps a scripted value `v < floor(2^32/max)*max` to
 * `v % max`, so small scripted values ARE the picked indices — which is
 * what makes the expectations below exact rather than statistical.
 */

const realGetRandomValues = crypto.getRandomValues.bind(crypto);
let sequence: number[] = [];
let cursor = 0;

beforeEach(() => {
  sequence = [];
  cursor = 0;
  jest
    .spyOn(crypto, 'getRandomValues')
    // The constraint mirrors lib.dom's own `getRandomValues` signature
    // (`ArrayBufferView<ArrayBufferLike> | null`); a bare `ArrayBufferView`
    // is a different type under the parameterised declaration and does not
    // unify with the real implementation's return.
    .mockImplementation(
      <T extends ArrayBufferView<ArrayBufferLike> | null>(buf: T): T => {
        // Anything that isn't the u32 buffer the generator asks for falls
        // through to real entropy. `buf` is narrowed to non-null here only
        // by the Uint32Array check below, so the null case goes through the
        // same passthrough — the cast re-asserts the identity lib.dom
        // declares but cannot prove through the branch.
        if (!(buf instanceof Uint32Array)) {
          return (buf === null ? buf : realGetRandomValues(buf)) as T;
        }
        if (cursor < sequence.length) {
          buf[0] = sequence[cursor]!;
          cursor += 1;
        } else {
          // Script exhausted — repeat the last value (keeps the read-preset
          // give-up test terminating without scripting 8 attempts by hand).
          buf[0] = sequence[sequence.length - 1] ?? 0;
        }
        return buf;
      },
    );
});

afterEach(() => jest.restoreAllMocks());

function opts(over: Partial<PasswordGeneratorDefaults>): PasswordGeneratorDefaults {
  return {
    preset: 'say',
    words: 3,
    length: 8,
    separator: 'hyphen',
    alternateCase: false,
    includeNumber: false,
    ...over,
  };
}

const POOL5 = getWordBucket(5);
const POOL4 = getWordBucket(4);
const AMBIGUOUS = new Set(['0', 'O', 'o', '1', 'l', 'I', 'i']);
const hasAmbiguous = (s: string) => [...s].some((c) => AMBIGUOUS.has(c));

// Indices resolved from the real pool so no word is hardcoded.
const cleanIdx = POOL5.findIndex((w) => !hasAmbiguous(w));
const ambigIdx = POOL5.findIndex((w) => hasAmbiguous(w));

describe('generatePassword', () => {
  it('joins the scripted word picks with the separator', () => {
    sequence = [0, 1, 2];
    const phrase = generatePassword(opts({ length: 8 }));
    const words = phrase.split('-');
    expect(words.slice(0, 3)).toEqual([POOL5[0], POOL5[1], POOL5[2]]);
    // Every word (top-up included, if the floor forced any) is from the pool.
    for (const w of words) expect(POOL5).toContain(w);
  });

  it('maps every separator option to its character', () => {
    sequence = [0, 1];
    expect(generatePassword(opts({ words: 2, separator: 'underscore' }))).toContain('_');
    sequence = [0, 1];
    cursor = 0;
    const spaced = generatePassword(opts({ words: 2, separator: 'space' }));
    expect(spaced.split(' ').length).toBeGreaterThanOrEqual(2);
    sequence = [0, 1];
    cursor = 0;
    const none = generatePassword(opts({ words: 2, separator: 'none', length: 8 }));
    expect(none).not.toMatch(/[\s_.-]/);
  });

  it('tops up with extra words until the length floor is cleared', () => {
    sequence = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const phrase = generatePassword(opts({ words: 2, length: 30 }));
    expect(phrase.length).toBeGreaterThanOrEqual(30);
    for (const w of phrase.split('-')) expect(POOL5).toContain(w);
  });

  it('clamps the floors: never fewer than 2 words, never shorter than 8 chars', () => {
    sequence = [0, 1, 2, 3, 4];
    const phrase = generatePassword(opts({ words: 0, length: 1 }));
    expect(phrase.split('-').length).toBeGreaterThanOrEqual(2);
    expect(phrase.length).toBeGreaterThanOrEqual(8);
  });

  it('Title-Cases every word under alternateCase', () => {
    sequence = [0, 1, 2, 3, 4];
    const phrase = generatePassword(opts({ alternateCase: true, length: 20 }));
    for (const w of phrase.split('-')) {
      expect(w).toMatch(/^[A-Z]/);
      expect(w.slice(1)).toBe(w.slice(1).toLowerCase());
    }
  });

  it('appends a 1–99 number to exactly the scripted host word', () => {
    // Call order: pick word 0, pick word 1, pick digit host, pick digits.
    sequence = [0, 1, 1, 41];
    const phrase = generatePassword(opts({ words: 2, length: 8, includeNumber: true }));
    const words = phrase.split('-');
    expect(words[0]).toBe(POOL5[0]);
    // randInt(99) with scripted 41 → 41, +1 → 42.
    expect(words[1]).toBe(`${POOL5[1]}42`);
  });

  it('draws the remember preset from the ≤4-letter bucket', () => {
    sequence = [0, 1, 2];
    const phrase = generatePassword(opts({ preset: 'remember', length: 8 }));
    for (const w of phrase.split('-')) expect(POOL4).toContain(w);
  });

  it('rejection-samples: an out-of-range uint32 is discarded, not modulo-folded', () => {
    // 0xFFFFFFFF ≥ floor(2^32/1296)*1296, so it must be rejected and the
    // NEXT scripted value used. Folding it instead would yield a biased
    // index — the exact trap randInt exists to avoid.
    expect(0xffffffff % POOL5.length).not.toBe(5); // guard: failure would be visible
    sequence = [0xffffffff, 5, 6, 7];
    const phrase = generatePassword(opts({ length: 8 }));
    expect(phrase.split('-')[0]).toBe(POOL5[5]);
  });

  it('read preset retries a phrase containing ambiguous characters', () => {
    expect(cleanIdx).toBeGreaterThanOrEqual(0);
    expect(ambigIdx).toBeGreaterThanOrEqual(0);
    // Attempt 1 picks ambiguous words → rejected; attempt 2 (and any
    // top-up) draws clean ones.
    sequence = [ambigIdx, ambigIdx, cleanIdx, cleanIdx, cleanIdx, cleanIdx];
    const phrase = generatePassword(
      opts({ preset: 'read', words: 2, length: 8 }),
    );
    expect(hasAmbiguous(phrase)).toBe(false);
  });

  it('read preset gives up after 8 attempts rather than looping forever', () => {
    // Script repeats the ambiguous index forever (mock repeats its last
    // value); the function must still return.
    sequence = [ambigIdx];
    const phrase = generatePassword(
      opts({ preset: 'read', words: 2, length: 8 }),
    );
    expect(phrase.length).toBeGreaterThan(0);
    expect(hasAmbiguous(phrase)).toBe(true);
  });
});
