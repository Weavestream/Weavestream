import type { ChatToolCallDto } from '@weavestream/shared';
import { proposalViews } from './proposal-card';

const ART = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function call(
  name: string,
  args: unknown,
  id = 'tc1',
  extra: Partial<ChatToolCallDto> = {},
): ChatToolCallDto {
  return {
    id,
    name,
    arguments: args,
    status: 'pending',
    ...extra,
  } as unknown as ChatToolCallDto;
}

describe('proposalViews', () => {
  it('turns proposal-mode calls into views with headline, title, and args', () => {
    const views = proposalViews([
      call('create_article', {
        title: '  Reboot runbook  ',
        markdown: '# Reboot runbook\n\nBody',
      }),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      headline: 'Drafted an article',
      title: 'Reboot runbook',
      markdown: '# Reboot runbook\n\nBody',
      treatAsCreate: true,
      isPatch: false,
      isRewrite: false,
    });
  });

  it('NEVER views read-tool calls — the tool_call event carries those too', () => {
    const views = proposalViews([
      call('search', { q: 'pines' }, 'r1'),
      call('get_article', { id: 'a1' }, 'r2'),
      call('get_company_summary', {}, 'r3'),
      call('patch_article', { title: 'Edit', article_id: ART }, 'p1'),
    ]);
    expect(views.map((v) => v.call.id)).toEqual(['p1']);
  });

  it('drops unknown tool names rather than guessing a mode', () => {
    expect(proposalViews([call('future_tool', { title: 'X' })])).toEqual([]);
  });

  it('classifies a revision-guarded rewrite as an EDIT, not a create', () => {
    const [view] = proposalViews([
      call('update_article', { article_id: ART, markdown: '# New' }, 'u1', {
        baseRevision: 7,
      }),
    ]);
    expect(view).toMatchObject({ isRewrite: true, treatAsCreate: false });
  });

  it('promotes a hallucinated rewrite (no basis) to a create ONLY with a body', () => {
    const [withBody] = proposalViews([
      call('update_article', { article_id: ART, markdown: '# New' }, 'u1', {
        baseRevision: null,
      }),
    ]);
    expect(withBody!.treatAsCreate).toBe(true);

    // markdown is optional on update_article (title-only edits); the
    // server's create-promotion requires a body, so a body-less
    // hallucinated target can never promote (plan-review P1-3).
    const [titleOnly] = proposalViews([
      call('update_article', { article_id: ART, title: 'Rename' }, 'u2', {
        baseRevision: null,
      }),
    ]);
    expect(titleOnly!.treatAsCreate).toBe(false);
  });

  it('survives malformed arguments without throwing', () => {
    // The schema deliberately admits malformed model output; every shape
    // here must produce a view (or not) without crashing the transcript.
    const shapes: unknown[] = [
      null,
      undefined,
      'not an object',
      42,
      { title: 42 },
      { title: null },
      { title: '   ' },
      {},
    ];
    for (const args of shapes) {
      const views = proposalViews([call('create_article', args, 'x')]);
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({
        headline: 'Drafted an article',
        title: null,
        markdown: null,
        treatAsCreate: true,
      });
    }
  });
});
