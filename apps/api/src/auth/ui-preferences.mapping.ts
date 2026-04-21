import { UiTheme as DbUiTheme, UiAccent as DbUiAccent } from '@prisma/client';
import type { UiTheme, UiAccent } from '@weavestream/shared';

/**
 * Phase 9b.1 — translate between the DB's uppercase enums and the
 * lowercase string literals we expose over the wire + in the
 * `ws_ui` cookie (which maps 1:1 to `data-theme` / `data-accent`).
 * Kept in a single tiny module so both AuthService (login) and
 * MeService (profile + PATCH) share the same mapping.
 */

export function themeFromDb(v: DbUiTheme): UiTheme {
  return v.toLowerCase() as UiTheme;
}

export function accentFromDb(v: DbUiAccent): UiAccent {
  return v.toLowerCase() as UiAccent;
}

export function themeToDb(v: UiTheme): DbUiTheme {
  return v.toUpperCase() as DbUiTheme;
}

export function accentToDb(v: UiAccent): DbUiAccent {
  return v.toUpperCase() as DbUiAccent;
}
