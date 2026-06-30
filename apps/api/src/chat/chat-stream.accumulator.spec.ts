import { ToolCallAccumulator } from './chat-stream.service.js';

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

  it('ignores tool calls that are not article tools', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest([
      { index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{}' } },
    ]);
    expect(acc.finalize('stop')).toHaveLength(0);
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
});
