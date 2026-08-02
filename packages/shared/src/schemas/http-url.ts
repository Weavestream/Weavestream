import { z } from 'zod';

export const HTTP_URL_VALIDATION_MESSAGE = 'Enter a valid URL starting with http:// or https://.';

// WHATWG URL parsing silently removes embedded tabs/newlines. Reject all C0
// controls and DEL before parsing so a value cannot change meaning during
// validation or when it is later rendered by a browser.
// eslint-disable-next-line no-control-regex -- matching controls is the point
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;
const HTTP_SCHEME_RE = /^https?:\/\//i;

export function isValidHttpUrl(value: string): boolean {
  if (!HTTP_SCHEME_RE.test(value) || CONTROL_CHARS_RE.test(value)) return false;

  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

/** Required, explicitly-schemed HTTP(S) URL shared by API and form validation. */
export const httpUrlSchema = z
  .string()
  .trim()
  .max(2048, HTTP_URL_VALIDATION_MESSAGE)
  .refine(isValidHttpUrl, HTTP_URL_VALIDATION_MESSAGE);

/** An optional URL field accepts blank input; non-blank input follows httpUrlSchema. */
export const optionalHttpUrlSchema = z
  .string()
  .trim()
  .max(2048, HTTP_URL_VALIDATION_MESSAGE)
  .refine((value) => value === '' || isValidHttpUrl(value), HTTP_URL_VALIDATION_MESSAGE);

export function optionalHttpUrlError(value: string): string | null {
  return optionalHttpUrlSchema.safeParse(value).success ? null : HTTP_URL_VALIDATION_MESSAGE;
}
