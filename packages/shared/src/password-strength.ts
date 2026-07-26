/**
 * Display constants for the zxcvbn 0–4 password-strength score.
 *
 * The score itself is computed **server-side only**
 * (`apps/api/src/passwords/password-strength.ts`, seeded with
 * name/username/url as penalty inputs) and travels on
 * `passwordSummarySchema.passwordStrength`. Clients render it; they
 * never re-score — shipping zxcvbn to a browser bundle costs ~400 KB
 * and a client-side score can still disagree with the server's
 * penalty inputs.
 *
 * Tones are **semantic names, not CSS**. Each app maps them to its own
 * styling primitives (desktop → `var(--danger)` etc., mobile →
 * Tailwind `bg-danger` etc.); assigning the raw string to a style
 * silently produces invalid CSS.
 */

export const PASSWORD_STRENGTH_LABELS = [
  'Very weak',
  'Weak',
  'Fair',
  'Strong',
  'Very strong',
] as const;

export type PasswordStrengthTone = 'danger' | 'warn' | 'ok';

export const PASSWORD_STRENGTH_TONES: readonly PasswordStrengthTone[] = [
  'danger',
  'danger',
  'warn',
  'ok',
  'ok',
] as const;
