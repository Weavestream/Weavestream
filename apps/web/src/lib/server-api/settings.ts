import { cache } from 'react';
import type {
  AiSettings,
  AlertConfig,
  ArticleEditorMode,
  EmailSettings,
  PasswordGeneratorDefaults,
} from '@weavestream/shared';
import { DEFAULT_PASSWORD_GENERATOR_DEFAULTS } from '@weavestream/shared';
import { serverApiFetch } from './core';

/**
 * Workspace branding + tenant terminology, fed from the singleton
 * `system_settings` row. Every authenticated page reads this once via
 * the root layout, so it's request-scoped memoized.
 */
export type Settings = {
  workspaceName: string;
  workspaceSubtitle: string;
  tenantTermSingular: string;
  tenantTermPlural: string;
  tenantTermPossessive: string | null;
  passwordGeneratorDefaults: PasswordGeneratorDefaults;
  articleAutosaveEnabled: boolean;
  /**
   * Workspace-wide default editor mode applied to *newly created*
   * articles. Existing articles keep their own `editorMode`. Resolved
   * server-side from `SystemSetting.articleDefaultEditorMode` and
   * piped into `ArticleForm` via the create-page server component.
   */
  articleDefaultEditorMode: ArticleEditorMode;
  updatedAt: string;
};

/**
 * Hard-coded defaults shipped with the product. Used when the API is
 * unreachable during SSR (first-paint on cold boot, or when running the
 * unauthenticated /login page). Must match the migration seed defaults
 * in packages/db/prisma/migrations/0006_phase5_system_settings.
 */
const DEFAULT_SETTINGS: Settings = {
  workspaceName: 'My Company',
  workspaceSubtitle: 'workspace',
  tenantTermSingular: 'Company',
  tenantTermPlural: 'Companies',
  tenantTermPossessive: null,
  passwordGeneratorDefaults: DEFAULT_PASSWORD_GENERATOR_DEFAULTS,
  articleAutosaveEnabled: false,
  articleDefaultEditorMode: 'tiptap',
  updatedAt: new Date(0).toISOString(),
};

// `/settings` is public and is called from the root layout on every
// request, including unauthenticated ones. On ANY failure — 401, 5xx,
// or the synthetic 503 from `serverApiFetch` when the backend is
// unreachable — fall back to `DEFAULT_SETTINGS`. Never throw: the root
// layout is the one thing that absolutely must render so the user can
// at least reach `/login` and re-authenticate. The extended retry loop
// in `serverApiFetch` (~5s) makes a real "down backend" reaching this
// branch exceedingly rare in practice.
export const getSettings = cache(async (): Promise<Settings> => {
  const res = await serverApiFetch<Settings>('/settings');
  if (!res.ok || !res.data) return DEFAULT_SETTINGS;
  return res.data;
});

const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  enabled: false,
  host: null,
  port: null,
  secureMode: 'STARTTLS',
  username: null,
  fromName: null,
  fromEmail: null,
  replyTo: null,
  passwordConfigured: false,
  updatedAt: new Date(0).toISOString(),
};

export const getEmailSettings = cache(async (): Promise<EmailSettings> => {
  const res = await serverApiFetch<EmailSettings>('/settings/email');
  if (!res.ok || !res.data) return DEFAULT_EMAIL_SETTINGS;
  return res.data;
});

const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  baseUrl: null,
  defaultModel: null,
  apiKeyConfigured: false,
  maxOutputTokens: null,
  contextWindowTokens: null,
  allowPrivateNetwork: false,
  autoSummaries: false,
  updatedAt: new Date(0).toISOString(),
};

export const getAiSettings = cache(async (): Promise<AiSettings> => {
  const res = await serverApiFetch<AiSettings>('/settings/ai');
  if (!res.ok || !res.data) return DEFAULT_AI_SETTINGS;
  return res.data;
});

/**
 * `/alerts` — list every active alert configuration. Returns `[]` on
 * any failure so the admin page can still render with a "no alerts
 * yet" empty state.
 */
export const getAlerts = cache(async (): Promise<AlertConfig[]> => {
  const res = await serverApiFetch<AlertConfig[]>('/alerts');
  if (!res.ok || !res.data) return [];
  return res.data;
});
