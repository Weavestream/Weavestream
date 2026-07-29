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
    expect(prompt).toContain(
      'Choose between get_app_help and search by the user’s intent, not by keywords or proper nouns',
    );
    expect(prompt).toContain(
      'what a feature or integration is, what it does, how it behaves',
    );
    expect(prompt).toContain(
      'Use search when the user wants information from their organization’s stored records',
    );
    expect(prompt).toContain('A named product or vendor alone does not imply either tool');
    expect(prompt).toContain('does not perform them or inspect live configuration');
    expect(prompt).toContain('do not guess from general model knowledge');
    expect(prompt).toContain('App-help sections have no href and need no link');
  });

  it('omits get_app_help from a CLIENT_USER prompt (F13)', () => {
    const clientActor = {
      id: 'user-2',
      email: 'client@example.com',
      role: 'CLIENT_USER',
    } as AuthedUser;
    const prompt = buildSystemPrompt(clientActor);
    expect(prompt).not.toContain('get_app_help');
    expect(prompt).not.toContain('authoritative reference for the deployed UI');
    // Other read tools are still described.
    expect(prompt).toContain('search(query');
    expect(prompt).toContain('get_article(article_id');
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

  // An org-free chat is offered create_article (chat-turn.ts), so the
  // prompt must describe it WITHOUT an active company — and must tell the
  // model not to guess a folder it has no company tree for.
  it('describes create_article without an active company, and suppresses folder_id', () => {
    const global = buildSystemPrompt(actor);
    expect(global).toContain('- create_article(title, markdown');
    expect(global).toContain('This chat has no active company, so omit folder_id');
    expect(global).toContain(
      'the user chooses the destination organization and folder when they approve the proposal',
    );
    expect(global).not.toContain('propose a brand-new article in the active company');

    const scoped = buildSystemPrompt(actor, {
      companyId: '11111111-1111-1111-1111-111111111111',
    });
    expect(scoped).toContain('propose a brand-new article in the active company');
    expect(scoped).not.toContain('This chat has no active company');
  });
});
