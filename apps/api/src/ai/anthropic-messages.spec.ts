import {
  AnthropicStreamError,
  acceptsForcedTool,
  fromAnthropicMessage,
  parseAnthropicStream,
  stripThinkingBlocks,
  toAnthropicMessages,
  toAnthropicRequest,
  type AnthropicStreamItem,
  type ChatShapeMessage,
} from './anthropic-messages.js';
import { parseSse } from './sse.js';
import type { OpenAiFunctionTool } from '../ai-tools/zod-openai.js';

const TOOL: OpenAiFunctionTool = {
  type: 'function',
  function: {
    name: 'search',
    strict: true,
    description: 'Search the knowledge base.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        types: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 5 },
      },
      required: ['query', 'types'],
    },
  },
};

const CREATE: OpenAiFunctionTool = {
  ...TOOL,
  function: { ...TOOL.function, name: 'create_article' },
};

describe('toAnthropicMessages', () => {
  it('moves all system text to the top-level system and caches its end', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'prelude note' },
      { role: 'system', content: 'main prompt' },
      { role: 'user', content: 'hi' },
    ]);
    expect(system).toEqual([
      { type: 'text', text: 'prelude note' },
      { type: 'text', text: 'main prompt', cache_control: { type: 'ephemeral' } },
    ]);
    expect(messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('turns tool calls into tool_use and groups tool results into one user message', () => {
    const history: ChatShapeMessage[] = [
      { role: 'user', content: 'find vpn' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '{"query":"vpn"}' } },
          { id: 'toolu_2', type: 'function', function: { name: 'search', arguments: '{bad json' } },
        ],
      },
      { role: 'tool', tool_call_id: 'toolu_1', content: 'result one' },
      { role: 'tool', tool_call_id: 'toolu_2', content: 'Invalid tool arguments.' },
    ];
    const { messages } = toAnthropicMessages(history);
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'find vpn' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'vpn' } },
          // Malformed arguments replay as an empty object.
          { type: 'tool_use', id: 'toolu_2', name: 'search', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'result one' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Invalid tool arguments.' },
        ],
      },
    ]);
  });

  it('replays providerBlocks unchanged, thinking included', () => {
    const blocks = [
      { type: 'thinking', thinking: 'plan', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'x' } },
    ];
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        providerBlocks: blocks,
        tool_calls: [
          { id: 'toolu_1', type: 'function', function: { name: 'search', arguments: '{"query":"x"}' } },
        ],
      },
    ]);
    expect(messages[1]).toEqual({ role: 'assistant', content: blocks });
  });

  it('merges consecutive user messages and skips empty text', () => {
    const { messages } = toAnthropicMessages([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: '   ' },
      { role: 'user', content: 'two' },
    ]);
    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
      },
    ]);
  });
});

describe('stripThinkingBlocks', () => {
  it('removes thinking and redacted_thinking, keeps text and tool_use', () => {
    const out = stripThinkingBlocks([
      {
        role: 'assistant',
        content: null,
        providerBlocks: [
          { type: 'thinking', thinking: 'a', signature: 's' },
          { type: 'redacted_thinking', data: 'x' },
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 't', name: 'search', input: {} },
        ],
      },
    ]);
    expect(out[0]!.providerBlocks).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't', name: 'search', input: {} },
    ]);
  });
});

describe('toAnthropicRequest', () => {
  const base = {
    model: 'claude-opus-5',
    messages: [{ role: 'user', content: 'hi' }] as ChatShapeMessage[],
    maxTokens: 8_192,
    reasoning: { thinking: { type: 'disabled' } },
    stream: true,
  };

  it('maps auto tools, strict schemas without maxItems, and never sends temperature', () => {
    const body = toAnthropicRequest({ ...base, tools: [TOOL], toolChoice: 'auto', forceTool: true });
    expect(body).toEqual({
      model: 'claude-opus-5',
      max_tokens: 8_192,
      stream: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        {
          name: 'search',
          description: 'Search the knowledge base.',
          strict: true,
          input_schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string' },
              types: { type: ['array', 'null'], items: { type: 'string' } },
            },
            required: ['query', 'types'],
          },
        },
      ],
      tool_choice: { type: 'auto' },
      thinking: { type: 'disabled' },
    });
    expect(body).not.toHaveProperty('temperature');
  });

  it('leaves maxItems and strict out together on a model without strict support', () => {
    const body = toAnthropicRequest({
      ...base,
      model: 'claude-sonnet-4-5',
      tools: [TOOL],
      toolChoice: 'auto',
      forceTool: true,
    });
    const tool = (body.tools as Array<Record<string, unknown>>)[0]!;
    expect(tool).not.toHaveProperty('strict');
    expect(tool.input_schema).toEqual(TOOL.function.parameters);
  });

  it('forces a named tool only when allowed', () => {
    const choice = { type: 'function' as const, function: { name: 'create_article' } };
    expect(
      toAnthropicRequest({ ...base, tools: [CREATE], toolChoice: choice, forceTool: true })
        .tool_choice,
    ).toEqual({ type: 'tool', name: 'create_article' });
    expect(
      toAnthropicRequest({ ...base, tools: [CREATE], toolChoice: choice, forceTool: false })
        .tool_choice,
    ).toEqual({ type: 'auto' });
  });

  it('forced-final round: sends the earlier tools with tool_choice none', () => {
    const body = toAnthropicRequest({
      ...base,
      messages: [
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 't1', content: 'r' },
      ],
      tools: null,
      toolChoice: null,
      replayTools: [TOOL],
      forceTool: false,
    });
    expect(body.tool_choice).toEqual({ type: 'none' });
    expect((body.tools as unknown[]).length).toBe(1);
  });

  it('omits tools entirely when neither this round nor the history uses them', () => {
    const body = toAnthropicRequest({
      ...base,
      tools: null,
      toolChoice: null,
      replayTools: [TOOL],
      forceTool: false,
    });
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });
});

describe('acceptsForcedTool', () => {
  it('rejects models that never accept it, and any request with thinking on', () => {
    expect(acceptsForcedTool('claude-opus-5-5', {})).toBe(false);
    expect(acceptsForcedTool('claude-opus-5', { thinking: { type: 'disabled' } })).toBe(true);
    // Opus 5 thinks by default unless disabled.
    expect(acceptsForcedTool('claude-opus-5', {})).toBe(false);
    expect(acceptsForcedTool('claude-opus-4-7', {})).toBe(true);
    expect(
      acceptsForcedTool('claude-opus-4-7', {
        thinking: { type: 'adaptive' },
        output_config: { effort: 'low' },
      }),
    ).toBe(false);
    expect(
      acceptsForcedTool('claude-haiku-4-5', { thinking: { type: 'enabled', budget_tokens: 1024 } }),
    ).toBe(false);
  });
});

describe('fromAnthropicMessage', () => {
  it('joins text blocks and maps the stop reason', () => {
    expect(
      fromAnthropicMessage({
        content: [
          { type: 'thinking', thinking: 'x' },
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
        stop_reason: 'max_tokens',
      }),
    ).toEqual({ text: 'ab', finishReason: 'length' });
    expect(fromAnthropicMessage(null)).toEqual({ text: '', finishReason: null });
  });
});

// ----------------------------------------------------------------------
// Stream fixtures — the wire format of the Messages streaming API.
// ----------------------------------------------------------------------

function sse(events: Array<[string, Record<string, unknown>]>, eol = '\n'): ReadableStream<Uint8Array> {
  const text = events
    .map(([name, data]) => `event: ${name}${eol}data: ${JSON.stringify({ type: name, ...data })}${eol}${eol}`)
    .join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // Uneven chunks, so frames and CRLF pairs split across reads.
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<AnthropicStreamItem[]> {
  const items: AnthropicStreamItem[] = [];
  for await (const item of parseAnthropicStream(parseSse(body))) items.push(item);
  return items;
}

const START: [string, Record<string, unknown>] = [
  'message_start',
  { message: { id: 'msg_1', role: 'assistant', content: [] } },
];

describe('parseAnthropicStream', () => {
  it('streams text and maps end_turn to stop', async () => {
    const items = await collect(
      sse([
        START,
        ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
        ['ping', {}],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }],
        ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'end_turn' } }],
        ['message_stop', {}],
      ]),
    );
    expect(items).toEqual([
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' },
      { kind: 'done', finishReason: 'stop', blocks: [{ type: 'text', text: 'Hello' }] },
    ]);
  });

  it('accepts CRLF line endings', async () => {
    const items = await collect(
      sse(
        [
          START,
          ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }],
          ['message_delta', { delta: { stop_reason: 'end_turn' } }],
          ['message_stop', {}],
        ],
        '\r\n',
      ),
    );
    expect(items[0]).toEqual({ kind: 'text', text: 'ok' });
    expect(items.at(-1)).toMatchObject({ kind: 'done', finishReason: 'stop' });
  });

  it('streams tool use as OpenAI-shaped deltas and keeps thinking for replay', async () => {
    const items = await collect(
      sse([
        START,
        ['content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }],
        ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Need ' } }],
        ['content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'search.' } }],
        ['content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'EqQB' } }],
        ['content_block_stop', { index: 0 }],
        [
          'content_block_start',
          { index: 1, content_block: { type: 'tool_use', id: 'toolu_9', name: 'search', input: {} } },
        ],
        ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '' } }],
        ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } }],
        ['content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"vpn"}' } }],
        ['content_block_stop', { index: 1 }],
        ['message_delta', { delta: { stop_reason: 'tool_use' } }],
        ['message_stop', {}],
      ]),
    );
    expect(items).toEqual([
      {
        kind: 'toolCallDelta',
        delta: { index: 1, id: 'toolu_9', type: 'function', function: { name: 'search', arguments: '' } },
      },
      { kind: 'toolCallDelta', delta: { index: 1, function: { arguments: '{"query":' } } },
      { kind: 'toolCallDelta', delta: { index: 1, function: { arguments: '"vpn"}' } } },
      {
        kind: 'done',
        finishReason: 'tool_calls',
        blocks: [
          { type: 'thinking', thinking: 'Need search.', signature: 'EqQB' },
          { type: 'tool_use', id: 'toolu_9', name: 'search', input: { query: 'vpn' } },
        ],
      },
    ]);
  });

  it('gives a tool with no parameters "{}" as its arguments', async () => {
    const items = await collect(
      sse([
        START,
        [
          'content_block_start',
          {
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_company_summary', input: {} },
          },
        ],
        ['content_block_stop', { index: 0 }],
        ['message_delta', { delta: { stop_reason: 'tool_use' } }],
        ['message_stop', {}],
      ]),
    );
    expect(items[1]).toEqual({
      kind: 'toolCallDelta',
      delta: { index: 0, function: { arguments: '{}' } },
    });
  });

  it('maps a refusal and max_tokens', async () => {
    const refusal = await collect(
      sse([START, ['message_delta', { delta: { stop_reason: 'refusal' } }], ['message_stop', {}]]),
    );
    expect(refusal.at(-1)).toEqual({ kind: 'done', finishReason: 'refusal', blocks: [] });
    const cut = await collect(
      sse([START, ['message_delta', { delta: { stop_reason: 'max_tokens' } }], ['message_stop', {}]]),
    );
    expect(cut.at(-1)).toMatchObject({ finishReason: 'length' });
  });

  it('throws a bounded error type on a mid-stream error event', async () => {
    const err = await collect(
      sse([
        START,
        ['error', { error: { type: 'overloaded_error', message: 'Overloaded <prompt text>' } }],
      ]),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicStreamError);
    expect((err as AnthropicStreamError).errorType).toBe('overloaded_error');
    expect((err as Error).message).not.toContain('prompt text');
  });

  it('throws, and yields no done item, when the stream ends before message_stop', async () => {
    const items: AnthropicStreamItem[] = [];
    const err = await (async () => {
      for await (const item of parseAnthropicStream(
        parseSse(
          sse([
            START,
            [
              'content_block_start',
              { index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} } },
            ],
            ['content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"qu' } }],
          ]),
        ),
      )) {
        items.push(item);
      }
    })().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicStreamError);
    expect((err as AnthropicStreamError).errorType).toBe('stream_interrupted');
    expect(items.some((i) => i.kind === 'done')).toBe(false);
  });
});
