import { resolveSettingsTab } from './tab-ids';

describe('resolveSettingsTab', () => {
  it('opens the API & MCP tab for the old "security" link', () => {
    expect(resolveSettingsTab('security')).toBe('api');
  });

  it('keeps every known tab', () => {
    for (const id of ['general', 'passwords', 'articles', 'email', 'ai', 'integrations', 'api']) {
      expect(resolveSettingsTab(id)).toBe(id);
    }
  });

  it('falls back to General for a missing or unknown tab', () => {
    expect(resolveSettingsTab(undefined)).toBe('general');
    expect(resolveSettingsTab('nope')).toBe('general');
  });
});
