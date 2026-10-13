import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceRoleLabel } from './workspace-role';

describe('workspaceRoleLabel', () => {
  it('labels each Workspace role', () => {
    expect(workspaceRoleLabel({ workspaceRole: 'PRIMARY', workspaceAliasOf: null })).toBe('Primary domain');
    expect(workspaceRoleLabel({ workspaceRole: 'SECONDARY', workspaceAliasOf: null })).toBe('Secondary domain');
    expect(workspaceRoleLabel({ workspaceRole: 'ALIAS', workspaceAliasOf: 'example.com' })).toBe('Domain alias of example.com');
    expect(workspaceRoleLabel({ workspaceRole: null, workspaceAliasOf: null })).toBeNull();
  });

  it('stays a plain module so the server-rendered domain page can call it', () => {
    expect(readFileSync(join(__dirname, 'workspace-role.ts'), 'utf8')).not.toMatch(/^\s*['"]use client['"]/);
  });
});
