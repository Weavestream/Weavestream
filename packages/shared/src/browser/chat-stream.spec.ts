import { streamChatMessage, type ChatStreamHandlers } from './chat-stream';
import { ensureCsrf } from './csrf';

/**
 * The SSE client's parsing and failure semantics, pinned at promotion
 * time (mobile Phase 3). The failure-origin distinctions matter: the
 * Ask panel's rollback policy branches on them, and getting one wrong
 * either duplicates a persisted turn or leaves the composer stuck.
 */

jest.mock('./csrf', () => ({ ensureCsrf: jest.fn() }));
const ensureCsrfMock = ensureCsrf as jest.Mock;

const encoder = new TextEncoder();

/** A closed body streaming `chunks` in order. */
function bodyOf(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

/** A body that yields `chunks` then fails the way an aborted fetch does. */
function abortedBodyAfter(...chunks: string[]): ReadableStream<Uint8Array> {
  // Pull-based: erroring inside start() would discard the queued chunks
  // before the reader ever saw them.
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
        return;
      }
      controller.error(
        new DOMException('The operation was aborted.', 'AbortError'),
      );
    },
  });
}

function okResponse(body: ReadableStream<Uint8Array>): Response {
  return { ok: true, status: 200, body } as unknown as Response;
}

type StreamHandlerKey =
  | 'onMeta'
  | 'onDelta'
  | 'onDone'
  | 'onError'
  | 'onTitle'
  | 'onToolActivity';

/**
 * Returns `jest.Mock`s rather than the bare handler signatures so tests
 * can read `.mock.calls`; the `satisfies` on the literal keeps the
 * compile-time check that these are exactly the handlers
 * `ChatStreamHandlers` declares, which the plain return annotation used
 * to provide (at the cost of erasing the mock type).
 */
function handlers(): Record<StreamHandlerKey, jest.Mock> {
  return {
    onMeta: jest.fn(),
    onDelta: jest.fn(),
    onDone: jest.fn(),
    onError: jest.fn(),
    onTitle: jest.fn(),
    onToolActivity: jest.fn(),
  } satisfies Required<Pick<ChatStreamHandlers, StreamHandlerKey>>;
}

const META =
  'event: meta\ndata: {"conversationId":"c1","userMessageId":"u1","assistantMessageId":"a1","title":"T"}\n\n';
const DONE = 'event: done\ndata: {"finishReason":"stop"}\n\n';

beforeEach(() => {
  jest.clearAllMocks();
  ensureCsrfMock.mockResolvedValue('csrf-token');
});

describe('streamChatMessage', () => {
  it('parses frames even when a delta splits across chunk boundaries', async () => {
    const h = handlers();
    global.fetch = jest.fn().mockResolvedValue(
      okResponse(
        bodyOf(
          META,
          'event: delta\ndata: {"te',
          'xt":"Hel',
          'lo"}\n\nevent: delta\ndata: {"text":" world"}\n\n',
          DONE,
        ),
      ),
    );

    await streamChatMessage('c1', 'hi', h);

    expect(h.onMeta).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1' }),
    );
    expect(h.onDelta.mock.calls.map((c) => c[0]).join('')).toBe('Hello world');
    expect(h.onDone).toHaveBeenCalledWith('stop');
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('reports a server error frame with origin "frame"', async () => {
    const h = handlers();
    global.fetch = jest.fn().mockResolvedValue(
      okResponse(bodyOf('event: error\ndata: {"message":"AI integration is disabled"}\n\n')),
    );

    await streamChatMessage('c1', 'hi', h);

    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith('AI integration is disabled', 'frame');
  });

  it('flushes a trailing block missing its blank-line terminator', async () => {
    const h = handlers();
    global.fetch = jest.fn().mockResolvedValue(
      okResponse(bodyOf(META, 'event: done\ndata: {"finishReason":"stop"}')),
    );

    await streamChatMessage('c1', 'hi', h);

    expect(h.onDone).toHaveBeenCalledWith('stop');
    // The tail-flushed `done` counts as the terminal — no phantom EOF error.
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('reports an unexpected clean EOF exactly once, as transport', async () => {
    const h = handlers();
    global.fetch = jest.fn().mockResolvedValue(
      okResponse(bodyOf(META, 'event: delta\ndata: {"text":"half an ans"}\n\n')),
    );

    await streamChatMessage('c1', 'hi', h);

    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError).toHaveBeenCalledWith(
      'Connection ended unexpectedly.',
      'transport',
    );
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it('emits nothing further after an abort — no EOF error, no transport error', async () => {
    const h = handlers();
    global.fetch = jest.fn().mockResolvedValue(
      okResponse(abortedBodyAfter(META, 'event: delta\ndata: {"text":"par"}\n\n')),
    );

    await streamChatMessage('c1', 'hi', h);

    expect(h.onDelta).toHaveBeenCalledWith('par');
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onDone).not.toHaveBeenCalled();
  });

  it('stays silent when the CSRF acquisition itself was aborted', async () => {
    const h = handlers();
    ensureCsrfMock.mockRejectedValue(
      new DOMException('The operation was aborted.', 'AbortError'),
    );
    global.fetch = jest.fn();

    await streamChatMessage('c1', 'hi', h);

    expect(h.onError).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reports a non-abort CSRF failure as PREFLIGHT — the POST never left this client', async () => {
    const h = handlers();
    const onRequestStarted = jest.fn();
    ensureCsrfMock.mockRejectedValue(new Error('csrf-fetch-failed'));
    global.fetch = jest.fn();

    await streamChatMessage('c1', 'hi', { ...h, onRequestStarted });

    expect(h.onError).toHaveBeenCalledWith(
      'Could not obtain CSRF token. Refresh and try again.',
      'preflight',
    );
    expect(onRequestStarted).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fires onRequestStarted once, before the POST and any frame', async () => {
    const h = handlers();
    const order: string[] = [];
    const onRequestStarted = jest.fn(() => order.push('requestStarted'));
    global.fetch = jest.fn().mockImplementation(() => {
      order.push('fetch');
      return Promise.resolve(okResponse(bodyOf(META, DONE)));
    });

    await streamChatMessage('c1', 'hi', {
      ...h,
      onRequestStarted,
      onMeta: jest.fn(() => order.push('meta')),
    });

    expect(onRequestStarted).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['requestStarted', 'fetch', 'meta']);
  });

  it('passes the abort signal through to the CSRF acquisition', async () => {
    const h = handlers();
    const controller = new AbortController();
    global.fetch = jest.fn().mockResolvedValue(okResponse(bodyOf(DONE)));

    await streamChatMessage('c1', 'hi', h, controller.signal);

    expect(ensureCsrfMock).toHaveBeenCalledWith(controller.signal);
  });

  it('reports a fetch failure as transport', async () => {
    const h = handlers();
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    await streamChatMessage('c1', 'hi', h);

    expect(h.onError).toHaveBeenCalledWith('network down', 'transport');
  });

  it('drops malformed frames without dying', async () => {
    const h = handlers();
    global.fetch = jest.fn().mockResolvedValue(
      okResponse(
        bodyOf(
          'event: delta\ndata: {not json}\n\n',
          'event: tool_activity\ndata: {"messageId":"m","status":"exploded"}\n\n',
          'event: delta\ndata: {"text":"still here"}\n\n',
          DONE,
        ),
      ),
    );

    await streamChatMessage('c1', 'hi', h);

    expect(h.onDelta).toHaveBeenCalledWith('still here');
    expect(h.onToolActivity).not.toHaveBeenCalled();
    expect(h.onDone).toHaveBeenCalledWith('stop');
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('routes an HTTP rejection to onHttpError INSTEAD of onError', async () => {
    const h = handlers();
    const onHttpError = jest.fn();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      body: null,
      json: () => Promise.resolve({ message: 'Unauthorized' }),
    } as unknown as Response);

    await streamChatMessage('c1', 'hi', { ...h, onHttpError });

    expect(onHttpError).toHaveBeenCalledWith(401, 'Unauthorized');
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('falls back to onError for an HTTP rejection when onHttpError is absent', async () => {
    const h = handlers();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 429,
      body: null,
      json: () => Promise.reject(new Error('no body')),
    } as unknown as Response);

    await streamChatMessage('c1', 'hi', h);

    expect(h.onError).toHaveBeenCalledWith('Request failed (429)');
  });
});
