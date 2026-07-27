import type { ChatToolCallDto } from '@weavestream/shared';
import {
  askReducer,
  initialAskState,
  type AskAction,
  type AskState,
} from './ask-reducer';

/**
 * Every transition of the Ask state machine, with the rollback policy
 * pinned hard: which failures may restore the draft (provably
 * unpersisted) and which must retain the turn (ambiguous). Getting one
 * branch wrong either duplicates a persisted turn on resend or leaves
 * the composer stuck streaming.
 */

function run(actions: AskAction[], from: AskState = initialAskState): AskState {
  return actions.reduce(askReducer, from);
}

const SEND: AskAction = {
  type: 'sendStarted',
  userClientId: 'u1',
  assistantClientId: 'a1',
  content: 'reboot steps?',
  creating: true,
};

const SEND_EXISTING: AskAction = { ...SEND, creating: false };

describe('askReducer — happy path', () => {
  it('sendStarted appends the optimistic pair and clears draft/sendError', () => {
    const s = run([
      { type: 'setDraft', draft: 'reboot steps?' },
      { type: 'streamFailed', message: 'old', provenance: 'http' },
      SEND,
    ]);
    expect(s.status).toBe('creating');
    expect(s.draft).toBe('');
    expect(s.sendError).toBeNull();
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.messages[1]!.state).toBe('streaming');
  });

  it('an existing conversation enters preflight, not streaming — CSRF is still ahead', () => {
    const s = run([SEND_EXISTING]);
    expect(s.status).toBe('preflight');
  });

  it('conversationCreated moves creating → preflight and stores the id', () => {
    const s = run([SEND, { type: 'conversationCreated', conversationId: 'c1' }]);
    // The message POST has not been dispatched yet.
    expect(s.status).toBe('preflight');
    expect(s.conversationId).toBe('c1');
  });

  it('requestStarted marks the dispatch: preflight → streaming, and only from preflight', () => {
    const s = run([SEND_EXISTING, { type: 'requestStarted' }]);
    expect(s.status).toBe('streaming');

    const settled = run([{ type: 'done' }], s);
    expect(askReducer(settled, { type: 'requestStarted' })).toEqual(settled);
  });

  it('meta marks the turn persisted; deltas accumulate; done settles and unlocks', () => {
    let s = run([
      SEND,
      { type: 'conversationCreated', conversationId: 'c1' },
      { type: 'requestStarted' },
      { type: 'meta', conversationId: 'c1' },
      { type: 'delta', text: 'Power off, ' },
      { type: 'delta', text: 'then on.' },
    ]);
    expect(s.metaReceived).toBe(true);
    expect(s.messages[1]!.text).toBe('Power off, then on.');

    s = askReducer(s, { type: 'done' });
    expect(s.messages[1]!.state).toBe('done');
    expect(s.status).toBe('idle');
    expect(s.toolActivity).toBeNull();
    expect(s.metaReceived).toBe(false);
  });

  it('tool activity toggles the transient label; toolCalls and notices attach to the bubble', () => {
    const calls = [{ id: 't1', name: 'create_article' }] as unknown as ChatToolCallDto[];
    let s = run([
      SEND_EXISTING,
      { type: 'toolActivity', label: 'Searching…' },
    ]);
    expect(s.toolActivity).toBe('Searching…');

    s = run(
      [
        { type: 'toolActivity', label: null },
        { type: 'notice', message: 'Context was trimmed.' },
        { type: 'toolCalls', toolCalls: calls },
      ],
      s,
    );
    expect(s.toolActivity).toBeNull();
    expect(s.messages[1]!.notices).toEqual(['Context was trimmed.']);
    expect(s.messages[1]!.toolCalls).toHaveLength(1);
  });

  it('a second turn appends after the first — transcript stays ordered', () => {
    const s = run([
      SEND,
      { type: 'meta', conversationId: 'c1' },
      { type: 'delta', text: 'one' },
      { type: 'done' },
      {
        type: 'sendStarted',
        userClientId: 'u2',
        assistantClientId: 'a2',
        content: 'and then?',
        creating: false,
      },
      { type: 'delta', text: 'two' },
    ]);
    expect(s.messages.map((m) => m.text)).toEqual([
      'reboot steps?',
      'one',
      'and then?',
      'two',
    ]);
  });
});

describe('askReducer — rollback policy', () => {
  it('createFailed rolls back the pair and restores the draft with sendError', () => {
    const s = run([SEND, { type: 'createFailed', message: 'Could not start.' }]);
    expect(s.messages).toEqual([]);
    expect(s.draft).toBe('reboot steps?');
    expect(s.sendError).toBe('Could not start.');
    expect(s.status).toBe('idle');
  });

  it('a PREFLIGHT failure rolls back — the message POST was never dispatched', () => {
    // CSRF acquisition failed inside the streamer, before the fetch.
    const s = run([
      SEND_EXISTING,
      {
        type: 'streamFailed',
        message: 'Could not obtain CSRF token. Refresh and try again.',
        provenance: 'preflight',
      },
    ]);
    expect(s.messages).toEqual([]);
    expect(s.draft).toBe('reboot steps?');
    expect(s.sendError).toBe(
      'Could not obtain CSRF token. Refresh and try again.',
    );
    expect(s.status).toBe('idle');
  });

  it('an HTTP rejection rolls back — it never reached the SSE controller', () => {
    const s = run([
      SEND_EXISTING,
      { type: 'requestStarted' },
      { type: 'streamFailed', message: 'Too many requests', provenance: 'http' },
    ]);
    expect(s.messages).toEqual([]);
    expect(s.draft).toBe('reboot steps?');
    expect(s.sendError).toBe('Too many requests');
    expect(s.status).toBe('idle');
  });

  it('a pre-meta error FRAME rolls back — the server fails before its DB write', () => {
    const s = run([
      SEND_EXISTING,
      { type: 'requestStarted' },
      {
        type: 'streamFailed',
        message: 'AI integration is disabled',
        provenance: 'frame',
      },
    ]);
    expect(s.messages).toEqual([]);
    expect(s.draft).toBe('reboot steps?');
    expect(s.sendError).toBe('AI integration is disabled');
  });

  it('RETAINS the turn when the DB commit may have landed but the connection closed before meta', () => {
    // The ambiguous window: persist happens before the meta write, so a
    // transport failure with no meta proves nothing. Rolling back and
    // resending would duplicate server history.
    const s = run([
      SEND_EXISTING,
      { type: 'requestStarted' },
      {
        type: 'streamFailed',
        message: 'Connection ended unexpectedly.',
        provenance: 'transport',
      },
    ]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]!.text).toBe('reboot steps?');
    expect(s.messages[1]!.state).toBe('error');
    expect(s.messages[1]!.error).toBe('Connection ended unexpectedly.');
    expect(s.draft).toBe('');
    expect(s.sendError).toBeNull();
    expect(s.status).toBe('idle');
  });

  it('a post-meta error frame settles in-bubble and keeps the user turn', () => {
    const s = run([
      SEND_EXISTING,
      { type: 'requestStarted' },
      { type: 'meta', conversationId: 'c1' },
      { type: 'delta', text: 'partial' },
      { type: 'streamFailed', message: 'Model failed', provenance: 'frame' },
    ]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]!.state).toBe('error');
    expect(s.messages[1]!.text).toBe('partial');
    expect(s.status).toBe('idle');
  });
});

describe('askReducer — Stop', () => {
  it('during creating: drops the pair and restores the draft, no error line', () => {
    const s = run([SEND, { type: 'stop' }]);
    expect(s.messages).toEqual([]);
    expect(s.draft).toBe('reboot steps?');
    expect(s.sendError).toBeNull();
    expect(s.status).toBe('idle');
  });

  it('during PREFLIGHT (CSRF still acquiring): drops the pair and restores the draft', () => {
    // The message POST hasn't been dispatched — nothing to duplicate,
    // so this is the same clean rollback as stop-during-creating.
    const s = run([SEND_EXISTING, { type: 'stop' }]);
    expect(s.messages).toEqual([]);
    expect(s.draft).toBe('reboot steps?');
    expect(s.sendError).toBeNull();
    expect(s.status).toBe('idle');
  });

  it('during streaming with text: keeps the user bubble and settles as done', () => {
    const s = run([
      SEND_EXISTING,
      { type: 'requestStarted' },
      { type: 'meta', conversationId: 'c1' },
      { type: 'delta', text: 'Power off' },
      { type: 'toolActivity', label: 'Searching…' },
      { type: 'stop' },
    ]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]!.state).toBe('done');
    expect(s.messages[1]!.text).toBe('Power off');
    expect(s.toolActivity).toBeNull();
    expect(s.draft).toBe('');
    expect(s.status).toBe('idle');
  });

  it('during streaming with no text yet: marks the bubble stopped, keeps the turn', () => {
    const s = run([SEND_EXISTING, { type: 'requestStarted' }, { type: 'stop' }]);
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]!.state).toBe('stopped');
    expect(s.status).toBe('idle');
  });

  it('is a no-op while idle', () => {
    const settled = run([SEND_EXISTING, { type: 'done' }]);
    expect(askReducer(settled, { type: 'stop' })).toEqual(settled);
  });
});

describe('askReducer — reset', () => {
  it('clears everything back to the initial state', () => {
    const s = run([
      { type: 'setDraft', draft: 'x' },
      SEND,
      { type: 'conversationCreated', conversationId: 'c1' },
      { type: 'delta', text: 'partial' },
      { type: 'reset' },
    ]);
    expect(s).toEqual(initialAskState);
  });
});
