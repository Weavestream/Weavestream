import { z } from 'zod';

/**
 * Phase 9b.1 — per-user appearance preferences.
 *
 * The API stores these UPPERCASE as enum columns on the `users` table
 * (see `UiTheme`, `UiAccent` in schema.prisma). Over the wire and in the
 * `ws_ui` cookie we use the lowercase CSS-friendly form so consumers can
 * drop the value straight into `data-theme` / `data-accent` without a
 * translation step. The API layer is responsible for normalising between
 * the two.
 */

export const uiThemeValues = ['dark', 'light', 'system'] as const;
export type UiTheme = (typeof uiThemeValues)[number];
export const uiThemeSchema = z.enum(uiThemeValues);

export const uiAccentValues = [
  'lime',
  'amber',
  'iris',
  'coral',
  'teal',
] as const;
export type UiAccent = (typeof uiAccentValues)[number];
export const uiAccentSchema = z.enum(uiAccentValues);

export const DEFAULT_UI_THEME: UiTheme = 'system';
export const DEFAULT_UI_ACCENT: UiAccent = 'lime';

/** Full resolved preference payload returned by /auth/me. */
export const userUiPreferencesSchema = z.object({
  uiTheme: uiThemeSchema,
  uiAccent: uiAccentSchema,
});
export type UserUiPreferences = z.infer<typeof userUiPreferencesSchema>;

/**
 * PATCH /me/preferences payload. Partial — either field may be sent
 * alone to change just the theme or just the accent. At least one must
 * be present to avoid no-op writes that still spend an audit row.
 */
export const userUiPreferencesUpdateSchema = z
  .object({
    uiTheme: uiThemeSchema.optional(),
    uiAccent: uiAccentSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one of uiTheme or uiAccent must be provided',
  });

export type UserUiPreferencesUpdate = z.infer<
  typeof userUiPreferencesUpdateSchema
>;

/**
 * Unauthenticated `POST /public/ui-prefs` payload. Only the theme may be
 * toggled without a session — accent is a signed-in preference only so
 * we don't need to write an accent cookie from the login page.
 */
export const publicUiPreferencesSchema = z.object({
  uiTheme: uiThemeSchema,
});

export type PublicUiPreferences = z.infer<typeof publicUiPreferencesSchema>;
