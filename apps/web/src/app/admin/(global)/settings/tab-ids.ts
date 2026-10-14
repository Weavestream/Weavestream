/**
 * Settings tab ids, kept out of the client component so the server page can
 * resolve `?tab=` too.
 */
export const SETTINGS_TAB_IDS = [
  'general',
  'passwords',
  'articles',
  'email',
  'ai',
  'integrations',
  'api',
] as const;

export type TabId = (typeof SETTINGS_TAB_IDS)[number];

/**
 * Resolve a `?tab=` value. `security` is the old name of the API & MCP tab;
 * links and docs that still say "Settings → Security" keep working.
 */
export function resolveSettingsTab(raw: string | undefined): TabId {
  if (raw === 'security') return 'api';
  return (SETTINGS_TAB_IDS as readonly string[]).includes(raw ?? '') ? (raw as TabId) : 'general';
}
