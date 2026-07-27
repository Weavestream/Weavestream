import {
  DEFAULT_UI_ACCENT,
  DEFAULT_UI_THEME,
  parseUiCookie,
  uiAccentValues,
  uiThemeValues,
  type UiAccent,
  type UiTheme,
} from '@weavestream/shared';
import { FALLBACK_SHELL_KEY, shellKeyFor } from './mobile-shell-key';

describe('shellKeyFor', () => {
  it('composes {accent}-{themePref} for every enum pair', () => {
    for (const uiAccent of uiAccentValues) {
      for (const uiTheme of uiThemeValues) {
        expect(shellKeyFor({ uiAccent, uiTheme })).toBe(
          `${uiAccent}-${uiTheme}`,
        );
      }
    }
  });

  it('degrades unknown values to the defaults (filename boundary)', () => {
    expect(
      shellKeyFor({
        uiAccent: '../etc/passwd' as UiAccent,
        uiTheme: 'blorp' as UiTheme,
      }),
    ).toBe(`${DEFAULT_UI_ACCENT}-${DEFAULT_UI_THEME}`);
  });

  it('agrees with parseUiCookie on a garbled cookie', () => {
    expect(shellKeyFor(parseUiCookie('t%3Ddark%3Ba%3Diris'))).toBe(
      // Still percent-ENCODED — parseUiCookie sees no valid pairs and
      // degrades, exactly like the route handler would.
      FALLBACK_SHELL_KEY,
    );
    expect(shellKeyFor(parseUiCookie('t=dark;a=iris'))).toBe('iris-dark');
    expect(shellKeyFor(parseUiCookie(undefined))).toBe(FALLBACK_SHELL_KEY);
  });

  it('fallback key names the default variant', () => {
    expect(FALLBACK_SHELL_KEY).toBe(
      `${DEFAULT_UI_ACCENT}-${DEFAULT_UI_THEME}`,
    );
  });
});
