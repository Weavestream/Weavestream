import { z } from 'zod';

/**
 * Phase 10 — workspace-wide defaults for the client-side password
 * generator. Stored as JSONB on `system_settings.password_generator_defaults`
 * and served alongside the rest of the settings singleton. The generator
 * itself (see apps/web/src/lib/password-generator.ts) is pure-client —
 * nothing here is ever sent back to the server on use.
 *
 * All three presets produce passphrases (word-based, CSPRNG-sampled).
 * They differ only in which word-length buckets from the EFF short
 * wordlist they draw from and in the sensible default for each knob:
 *
 *   - `say`      — easier to say     (≤ 6 letter words, lowercase-friendly)
 *   - `read`     — easier to read    (≤ 5 letter words, ambiguous chars stripped)
 *   - `remember` — easier to remember (≤ 4 letter words for a short phrase)
 *
 * The knob schema is shared across presets: each preset seeds the knobs
 * with recommended values when selected, and users can then tweak any
 * knob inside the popover without jumping back to a preset.
 */

export const passwordGeneratorPresetValues = [
  'say',
  'read',
  'remember',
] as const;
export type PasswordGeneratorPreset = (typeof passwordGeneratorPresetValues)[number];
export const passwordGeneratorPresetSchema = z.enum(
  passwordGeneratorPresetValues,
);

export const passwordGeneratorSeparatorValues = [
  'space',
  'hyphen',
  'underscore',
  'dot',
  'none',
] as const;
export type PasswordGeneratorSeparator =
  (typeof passwordGeneratorSeparatorValues)[number];
export const passwordGeneratorSeparatorSchema = z.enum(
  passwordGeneratorSeparatorValues,
);

/**
 * `length` here is a *minimum length floor* — the generator keeps
 * appending words until the passphrase is at least this many characters
 * long. That gives us one uniform knob schema across all three presets
 * without dragging a separate "char mode" branch into the UI.
 */
export const passwordGeneratorDefaultsSchema = z.object({
  preset: passwordGeneratorPresetSchema,
  length: z.number().int().min(8).max(64),
  words: z.number().int().min(2).max(10),
  separator: passwordGeneratorSeparatorSchema,
  alternateCase: z.boolean(),
  includeNumber: z.boolean(),
});
export type PasswordGeneratorDefaults = z.infer<
  typeof passwordGeneratorDefaultsSchema
>;

export const DEFAULT_PASSWORD_GENERATOR_DEFAULTS: PasswordGeneratorDefaults = {
  preset: 'say',
  length: 20,
  words: 4,
  separator: 'hyphen',
  alternateCase: true,
  includeNumber: true,
};

/**
 * Per-preset "recommended" values used by the popover's preset picker
 * and as the admin settings page's baseline. Separate from
 * `DEFAULT_PASSWORD_GENERATOR_DEFAULTS` because that is the *overall*
 * workspace fallback when no row has been saved yet.
 */
export const PASSWORD_GENERATOR_PRESET_DEFAULTS: Record<
  PasswordGeneratorPreset,
  Omit<PasswordGeneratorDefaults, 'preset'>
> = {
  say: {
    length: 20,
    words: 4,
    separator: 'hyphen',
    alternateCase: true,
    includeNumber: true,
  },
  read: {
    length: 18,
    words: 4,
    separator: 'hyphen',
    alternateCase: false,
    includeNumber: true,
  },
  remember: {
    length: 12,
    words: 3,
    separator: 'hyphen',
    alternateCase: true,
    includeNumber: false,
  },
};

/**
 * Runtime char used when rendering a passphrase with the named
 * separator. Kept in the shared module so the preview renderer in the
 * admin settings form matches the popover byte-for-byte.
 */
export const PASSWORD_GENERATOR_SEPARATOR_CHARS: Record<
  PasswordGeneratorSeparator,
  string
> = {
  space: ' ',
  hyphen: '-',
  underscore: '_',
  dot: '.',
  none: '',
};
