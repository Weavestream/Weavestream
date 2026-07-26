import {
  PASSWORD_STRENGTH_LABELS,
  PASSWORD_STRENGTH_TONES,
} from './password-strength';

describe('password strength display constants', () => {
  it('covers exactly the five zxcvbn scores, index-aligned', () => {
    // Both arrays are indexed straight by the 0–4 score; a length drift
    // between them silently paints the wrong tone on the top score.
    expect(PASSWORD_STRENGTH_LABELS).toHaveLength(5);
    expect(PASSWORD_STRENGTH_TONES).toHaveLength(5);
  });

  it('keeps the desktop tone ramp: danger ×2, warn, ok ×2', () => {
    expect(PASSWORD_STRENGTH_TONES).toEqual(['danger', 'danger', 'warn', 'ok', 'ok']);
    expect(PASSWORD_STRENGTH_LABELS[0]).toBe('Very weak');
    expect(PASSWORD_STRENGTH_LABELS[4]).toBe('Very strong');
  });
});
