import type { AuthedUser } from '../common/current-user.decorator.js';
import { buildSystemPrompt } from './chat-stream.service.js';

describe('buildSystemPrompt app help guidance', () => {
  const actor = {
    id: 'user-1',
    email: 'operator@example.com',
    role: 'OPERATOR',
  } as AuthedUser;

  it('distinguishes product help from tenant search in freeform chat', () => {
    const prompt = buildSystemPrompt(actor);
    expect(prompt).toContain('get_app_help(question)');
    expect(prompt).toContain('authoritative reference for the deployed UI');
    expect(prompt).toContain('Use search for organization-specific records');
    expect(prompt).toContain('does not perform them or inspect live configuration');
    expect(prompt).toContain('do not guess from general model knowledge');
    expect(prompt).toContain('App-help sections have no href and need no link');
  });

  it('does not grant an asset or integration mutation tool', () => {
    const prompt = buildSystemPrompt(actor, {
      companyId: '11111111-1111-1111-1111-111111111111',
    });
    expect(prompt).toContain('You cannot create or modify assets or domains');
    expect(prompt).not.toContain('- create_asset(');
    expect(prompt).not.toContain('- update_asset(');
    expect(prompt).not.toContain('- create_integration(');
  });
});
