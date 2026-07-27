import type { ChatToolCallDto } from '@weavestream/shared';
import { proposalCards } from './proposal-card';

function call(
  name: string,
  args: Record<string, unknown>,
  id = 'tc1',
): ChatToolCallDto {
  return {
    id,
    name,
    arguments: args,
    status: 'pending',
  } as unknown as ChatToolCallDto;
}

describe('proposalCards', () => {
  it('turns proposal-mode calls into cards with headline and title', () => {
    const cards = proposalCards([
      call('create_article', { title: '  Reboot runbook  ' }),
    ]);
    expect(cards).toEqual([
      { id: 'tc1', headline: 'Drafted an article', title: 'Reboot runbook' },
    ]);
  });

  it('NEVER cards read-tool calls — the tool_call event carries those too', () => {
    const cards = proposalCards([
      call('search', { q: 'pines' }, 'r1'),
      call('get_article', { id: 'a1' }, 'r2'),
      call('get_company_summary', {}, 'r3'),
      call('patch_article', { title: 'Edit' }, 'p1'),
    ]);
    expect(cards.map((c) => c.id)).toEqual(['p1']);
  });

  it('drops unknown tool names rather than guessing a mode', () => {
    expect(proposalCards([call('future_tool', { title: 'X' })])).toEqual([]);
  });

  it('survives malformed arguments without throwing', () => {
    // The schema deliberately admits malformed model output; every shape
    // here must produce a card (or not) without crashing the transcript.
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
      const cards = proposalCards([
        {
          id: 'x',
          name: 'create_article',
          arguments: args,
          status: 'pending',
        } as unknown as ChatToolCallDto,
      ]);
      expect(cards).toEqual([
        { id: 'x', headline: 'Drafted an article', title: null },
      ]);
    }
  });
});
