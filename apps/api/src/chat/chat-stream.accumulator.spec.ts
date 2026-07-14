import {
  sanitizeIntentPrelude,
  ToolCallAccumulator,
} from './chat-stream.service.js';

const ART = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('ToolCallAccumulator', () => {
  it('concatenates streamed argument fragments and parses at finalize', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([{ index: 0, id: 'c1', function: { name: 'update_article' } }]);
    acc.ingest([{ index: 0, function: { arguments: '{"article_id":"' } }]);
    acc.ingest([{ index: 0, function: { arguments: `${ART}","markdown":"hi"}` } }]);
    const call = acc.finalize('stop')[0]!;
    expect(call.status).toBe('pending');
    expect(call.errorCode).toBeNull();
    expect(call.arguments).toEqual({ article_id: ART, markdown: 'hi' });
  });

  it('handles a whole-blob single chunk (vLLM/Ollama style)', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([
      {
        index: 0,
        id: 'c1',
        function: {
          name: 'create_article',
          arguments: '{"title":"T","markdown":"B"}',
        },
      },
    ]);
    const call = acc.finalize('stop')[0]!;
    expect(call.status).toBe('pending');
    expect(call.name).toBe('create_article');
  });

  it('reports truncation (not a raw escape error) when finish_reason is length', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([{ index: 0, id: 'c1', function: { name: 'update_article' } }]);
    // Cut off mid-string — invalid JSON.
    acc.ingest([
      { index: 0, function: { arguments: '{"article_id":"x","markdown":"half of a bod' } },
    ]);
    const call = acc.finalize('length')[0]!;
    expect(call.status).toBe('failed');
    expect(call.errorCode).toBe('truncated');
    expect(call.error).toMatch(/cut off/i);
  });

  it('reports malformed when JSON is invalid but the stream finished normally', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([{ index: 0, id: 'c1', function: { name: 'update_article' } }]);
    acc.ingest([{ index: 0, function: { arguments: '{not valid json}' } }]);
    const call = acc.finalize('stop')[0]!;
    expect(call.status).toBe('failed');
    expect(call.errorCode).toBe('malformed');
  });

  it('marks an empty arguments blob as empty', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([{ index: 0, id: 'c1', function: { name: 'create_article' } }]);
    const call = acc.finalize('stop')[0]!;
    expect(call.status).toBe('failed');
    expect(call.errorCode).toBe('empty');
  });

  it('rejects non-object argument JSON as malformed', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([{ index: 0, id: 'c1', function: { name: 'update_article' } }]);
    acc.ingest([{ index: 0, function: { arguments: '"just a string"' } }]);
    const call = acc.finalize('stop')[0]!;
    expect(call.status).toBe('failed');
    expect(call.errorCode).toBe('malformed');
  });

  it('ignores tool calls with names outside the registry', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([
      { index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{}' } },
    ]);
    expect(acc.finalize('stop')).toHaveLength(0);
  });

  it('accepts read-tool names (WS-030)', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([
      { index: 0, id: 'c1', function: { name: 'search', arguments: '{"query":"backup"}' } },
      { index: 1, id: 'c2', function: { name: 'get_article', arguments: `{"article_id":"${ART}","cursor":null}` } },
    ]);
    const calls = acc.finalize('stop');
    expect(calls.map((c) => c.name)).toEqual(['search', 'get_article']);
    expect(calls.every((c) => c.status === 'pending')).toBe(true);
  });

  it('returns the raw arguments blob for the upstream echo', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([{ index: 0, id: 'c1', function: { name: 'search' } }]);
    acc.ingest([{ index: 0, function: { arguments: '{"query":' } }]);
    acc.ingest([{ index: 0, function: { arguments: '"rotation"}' } }]);
    const call = acc.finalize('stop')[0]!;
    expect(call.rawArguments).toBe('{"query":"rotation"}');
  });

  it('keeps multiple calls separated by index', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([
      { index: 0, id: 'c1', function: { name: 'update_article', arguments: `{"article_id":"${ART}"}` } },
      { index: 1, id: 'c2', function: { name: 'create_article', arguments: '{"title":"T","markdown":"B"}' } },
    ]);
    const calls = acc.finalize('stop');
    expect(calls.map((c) => c.name)).toEqual(['update_article', 'create_article']);
  });

  it('separates parallel calls that omit index, keyed by a fresh id (F4)', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([
      { id: 'c1', function: { name: 'search', arguments: '{"query":"backup"}' } },
      {
        id: 'c2',
        function: { name: 'get_article', arguments: `{"article_id":"${ART}","cursor":null}` },
      },
    ]);
    const calls = acc.finalize('stop');
    expect(calls.map((c) => c.name)).toEqual(['search', 'get_article']);
    expect(calls.every((c) => c.status === 'pending')).toBe(true);
    // finalize() does not strip nulls — stripNullArgs runs later, at apply.
    expect(calls[1]!.arguments).toEqual({ article_id: ART, cursor: null });
  });

  it('separates index-less calls by a new name once the current args parse', () => {
    const acc = new ToolCallAccumulator();
    // No id at all — split on the second name because the first call's
    // arguments already form a complete JSON object.
    acc.ingest([{ function: { name: 'search', arguments: '{"query":"a"}' } }]);
    acc.ingest([{ function: { name: 'search', arguments: '{"query":"b"}' } }]);
    const calls = acc.finalize('stop');
    expect(calls.map((c) => c.name)).toEqual(['search', 'search']);
    expect(calls.map((c) => c.arguments)).toEqual([{ query: 'a' }, { query: 'b' }]);
  });

  it('does not split a single index-less call streamed as fragments', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([{ function: { name: 'search' } }]);
    acc.ingest([{ function: { arguments: '{"query":' } }]);
    acc.ingest([{ function: { arguments: '"rotation"}' } }]);
    const calls = acc.finalize('stop');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.arguments).toEqual({ query: 'rotation' });
  });
});

describe('sanitizeIntentPrelude', () => {
  it('keeps a normal user-facing intent sentence', () => {
    expect(
      sanitizeIntentPrelude(
        "I'll review the attached ticket and draft a brief summary for approval.",
      ),
    ).toBe("I'll review the attached ticket and draft a brief summary for approval.");
  });

  it('drops reasoning or prompt-echo text instead of showing it to users', () => {
    expect(
      sanitizeIntentPrelude(
        'We need to produce a short assistant sentence before a proposed article tool action.',
      ),
    ).toBeNull();
    expect(
      sanitizeIntentPrelude(
        'The sentence should be specific to the user request and available context.',
      ),
    ).toBeNull();
  });

  it('strips tagged thinking and keeps the final sentence', () => {
    expect(
      sanitizeIntentPrelude(
        "<think>We need to produce a short assistant sentence.</think>I'll draft a brief article summary for review.",
      ),
    ).toBe("I'll draft a brief article summary for review.");
  });
});
