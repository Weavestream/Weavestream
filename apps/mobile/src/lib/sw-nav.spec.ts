/**
 * Behavior tests for the deadline-bounded SW navigation/warm logic
 * (Phase 5a A1). Default node environment on purpose: jest's node env
 * forwards Node 24's real Response/Request/AbortController, which a
 * jsdom docblock would REMOVE. Cache fakes genuinely consume their
 * Response bodies (`await res.text()`), so body locking and the clone
 * discipline are real in these tests, not simulated.
 */
import {
  NAV_DEADLINE_MS,
  PIN_DEADLINE_MS,
  SHELL_MAX_ENTRIES,
  WARM_DEADLINE_MS,
  createNavigationHandler,
  createWarmCanonical,
  settleWithin,
  type NavDeps,
} from './sw-nav';

const ORIGIN = 'https://app.test';
const CANONICAL_URL = '/m/app';
const NAV_URL = `${ORIGIN}/m/passwords/abc`;
const SHELL_HTML = '<html>shell</html>';

/** URL-string-keyed cache fake whose put() CONSUMES the response body. */
class FakeCache {
  store = new Map<string, { body: string; contentType: string }>();
  puts: Array<{ key: string; body: string }> = [];
  putImpl: ((key: string, res: Response) => Promise<void>) | null = null;

  async put(key: string, res: Response): Promise<void> {
    if (this.putImpl) return this.putImpl(key, res);
    const body = await res.text();
    this.puts.push({ key, body });
    this.store.set(key, {
      body,
      contentType: res.headers.get('content-type') ?? 'text/html',
    });
  }

  async match(key: string): Promise<Response | undefined> {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    return new Response(hit.body, {
      headers: { 'content-type': hit.contentType },
    });
  }

  async keys(): Promise<Request[]> {
    // Insertion order, like the real Cache API — FIFO trim depends on it.
    return [...this.store.keys()].map((url) => ({ url }) as Request);
  }

  async delete(key: Request | string): Promise<boolean> {
    const url = typeof key === 'string' ? key : key.url;
    return this.store.delete(url);
  }

  seed(key: string, body: string): void {
    this.store.set(key, { body, contentType: 'text/html' });
  }
}

function setup(fetchFn: NavDeps['fetchFn']) {
  const shell = new FakeCache();
  const canonical = new FakeCache();
  const log = jest.fn();
  const copied: Array<{ url: string; redirected: boolean }> = [];
  const deps: NavDeps = {
    fetchFn,
    openCache: async (name) =>
      (name === 'shell' ? shell : canonical) as unknown as Cache,
    copyResponse: async (r) => {
      // Marker fake: records the PRE-COPY metadata it was handed and
      // stamps its output. The branch is ours; workbox's impl is trusted.
      copied.push({ url: r.url, redirected: r.redirected });
      const body = await r.clone().text();
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/html', 'x-copied': '1' },
      });
    },
    shellCacheName: 'shell',
    canonicalCacheName: 'canonical',
    canonicalUrl: CANONICAL_URL,
    expectedOrigin: ORIGIN,
    log,
  };
  return { deps, shell, canonical, log, copied };
}

function navEvent() {
  const waited: Promise<unknown>[] = [];
  return {
    event: { waitUntil: (p: Promise<unknown>) => void waited.push(p) },
    waited,
  };
}

function htmlResponse(body = SHELL_HTML, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html' },
    ...init,
  });
}

/** Real Response with `redirected`/`url` shadowed — the flags are set by
 *  fetch machinery and aren't constructible, so own props stand in. */
function redirectedTo(finalUrl: string, body = SHELL_HTML): Response {
  const res = htmlResponse(body);
  Object.defineProperties(res, {
    redirected: { value: true },
    url: { value: finalUrl },
  });
  return res;
}

/** Fetch that never settles but honors its AbortSignal. */
function stalledFetch() {
  const state = { aborted: false };
  const fetchFn: NavDeps['fetchFn'] = (_url, { signal }) =>
    new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        state.aborted = true;
        reject(new DOMException('Aborted', 'AbortError'));
      });
    });
  return { fetchFn, state };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A late settlement crosses several async frames (put → pin → observer)
 *  before it reaches `log`; drain enough microtask ticks to see it. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('createNavigationHandler', () => {
  it('stalled fetch: aborts at the deadline, serves the canonical shell, and every event-lifetime promise settles', async () => {
    const { fetchFn, state } = stalledFetch();
    const { deps, canonical } = setup(fetchFn);
    canonical.seed(CANONICAL_URL, SHELL_HTML);
    const { event, waited } = navEvent();

    const resP = createNavigationHandler(deps)({
      request: new Request(NAV_URL),
      event,
    });
    await jest.advanceTimersByTimeAsync(NAV_DEADLINE_MS);

    const res = await resP;
    expect(state.aborted).toBe(true);
    expect(await res.text()).toBe(SHELL_HTML);
    // Failure path registers no background work; nothing can pin the event.
    expect(waited).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fast rejection: shell exact-URL hit wins, then canonical, then Response.error() — never a throw', async () => {
    const failing: NavDeps['fetchFn'] = async () => {
      throw new TypeError('fetch failed');
    };

    const exact = setup(failing);
    exact.shell.seed(NAV_URL, '<html>exact</html>');
    exact.canonical.seed(CANONICAL_URL, SHELL_HTML);
    const r1 = await createNavigationHandler(exact.deps)({
      request: new Request(NAV_URL),
      event: navEvent().event,
    });
    expect(await r1.text()).toBe('<html>exact</html>');

    const canonicalOnly = setup(failing);
    canonicalOnly.canonical.seed(CANONICAL_URL, SHELL_HTML);
    const r2 = await createNavigationHandler(canonicalOnly.deps)({
      request: new Request(NAV_URL),
      event: navEvent().event,
    });
    expect(await r2.text()).toBe(SHELL_HTML);

    const empty = setup(failing);
    const r3 = await createNavigationHandler(empty.deps)({
      request: new Request(NAV_URL),
      event: navEvent().event,
    });
    expect(r3.type).toBe('error');
  });

  it('success: serves the response, pins canonical + shell, FIFO-trims, and the served body outlives the consumed clones', async () => {
    const { deps, shell, canonical } = setup(async () => htmlResponse());
    // Pre-fill to the cap so the new entry forces one FIFO eviction.
    for (let i = 0; i < SHELL_MAX_ENTRIES; i += 1) {
      shell.seed(`${ORIGIN}/m/seed-${i}`, 'old');
    }
    const { event, waited } = navEvent();

    const res = await createNavigationHandler(deps)({
      request: new Request(NAV_URL),
      event,
    });
    expect(waited).toHaveLength(1);
    await Promise.all(waited);

    // Both cache fakes consumed their own clones…
    expect(canonical.store.get(CANONICAL_URL)?.body).toBe(SHELL_HTML);
    expect(shell.store.get(NAV_URL)?.body).toBe(SHELL_HTML);
    // …and the served instance is still readable afterwards.
    expect(await res.text()).toBe(SHELL_HTML);
    // FIFO trim: oldest seed evicted, cap respected.
    expect(shell.store.size).toBe(SHELL_MAX_ENTRIES);
    expect(shell.store.has(`${ORIGIN}/m/seed-0`)).toBe(false);
    expect(shell.store.has(NAV_URL)).toBe(true);
    // Nav timer + settleWithin timer both cleared.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('in-scope redirect: validates the PRE-copy url, serves and pins the normalized copy', async () => {
    const finalUrl = `${ORIGIN}/m/app`;
    const { deps, canonical, copied } = setup(async () =>
      redirectedTo(finalUrl),
    );
    const { event, waited } = navEvent();

    const res = await createNavigationHandler(deps)({
      request: new Request(NAV_URL),
      event,
    });
    await Promise.all(waited);

    expect(copied).toEqual([{ url: finalUrl, redirected: true }]);
    expect(res.headers.get('x-copied')).toBe('1');
    expect(canonical.puts).toHaveLength(1);
    expect(await res.text()).toBe(SHELL_HTML);
  });

  it.each([
    ['another origin', 'https://evil.test/m/app'],
    ['a path outside /m/', `${ORIGIN}/login`],
  ])(
    'off-scope redirect (%s): surfaces the redirect, pins nothing',
    async (_label, finalUrl) => {
      const { deps, shell, canonical, copied } = setup(async () =>
        redirectedTo(finalUrl),
      );
      const { event, waited } = navEvent();

      const res = await createNavigationHandler(deps)({
        request: new Request(NAV_URL),
        event,
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(finalUrl);
      expect(copied).toHaveLength(0);
      expect(shell.puts).toHaveLength(0);
      expect(canonical.puts).toHaveLength(0);
      expect(waited).toHaveLength(0);
    },
  );

  it.each([
    ['non-HTML', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })],
    ['non-ok', () => htmlResponse('<html>missing shell</html>', { status: 503 })],
  ])('%s response: passed through untouched, nothing cached', async (_label, make) => {
    const upstream = make();
    const { deps, shell, canonical } = setup(async () => upstream);
    const { event, waited } = navEvent();

    const res = await createNavigationHandler(deps)({
      request: new Request(NAV_URL),
      event,
    });

    expect(res).toBe(upstream);
    expect(shell.puts).toHaveLength(0);
    expect(canonical.puts).toHaveLength(0);
    expect(waited).toHaveLength(0);
  });

  it('pin deadline: a stalled cache write cannot pin the event, and its late failure is still logged', async () => {
    const { deps, canonical, log } = setup(async () => htmlResponse());
    const hung = deferred<void>();
    canonical.putImpl = () => hung.promise;
    const { event, waited } = navEvent();

    await createNavigationHandler(deps)({
      request: new Request(NAV_URL),
      event,
    });
    expect(waited).toHaveLength(1);

    let settled = false;
    void waited[0]?.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(PIN_DEADLINE_MS);
    expect(settled).toBe(true); // bounded: the event-lifetime promise is done

    hung.reject(new Error('quota exceeded'));
    await flushMicrotasks();
    expect(log).toHaveBeenCalledWith(
      'background cache write failed',
      expect.objectContaining({ message: 'quota exceeded' }),
    );
  });

  it('pin rejection before the deadline is logged, not swallowed', async () => {
    const { deps, canonical, log } = setup(async () => htmlResponse());
    canonical.putImpl = async () => {
      throw new Error('disk full');
    };
    const { event, waited } = navEvent();

    await createNavigationHandler(deps)({
      request: new Request(NAV_URL),
      event,
    });
    await Promise.all(waited); // resolves despite the early failure

    expect(log).toHaveBeenCalledWith(
      'background cache write failed',
      expect.objectContaining({ message: 'disk full' }),
    );
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('settleWithin', () => {
  it('logs a rejection that lands after its deadline (observed straggler)', async () => {
    const log = jest.fn();
    const hung = deferred<void>();

    const wrapper = settleWithin(hung.promise, 1000, log);
    await jest.advanceTimersByTimeAsync(1000);
    await wrapper; // resolved by the deadline

    hung.reject(new Error('late failure'));
    await Promise.resolve();
    expect(log).toHaveBeenCalledWith(
      'background cache write failed',
      expect.objectContaining({ message: 'late failure' }),
    );
  });
});

describe('createWarmCanonical', () => {
  it('stalled fetch: rejects at WARM_DEADLINE_MS, aborts the fetch, and logs inside the worker', async () => {
    const { fetchFn, state } = stalledFetch();
    const { deps, log } = setup(fetchFn);

    const warmP = createWarmCanonical(deps)();
    const outcome = expect(warmP).rejects.toThrow(
      `deadline of ${WARM_DEADLINE_MS}ms exceeded`,
    );
    await jest.advanceTimersByTimeAsync(WARM_DEADLINE_MS);
    await outcome;

    expect(state.aborted).toBe(true);
    expect(log).toHaveBeenCalledWith('canonical warm failed', expect.anything());
  });

  it('stalled cache.put: the install-facing promise still rejects; the disowned put is observed, never unhandled', async () => {
    const { deps, canonical, log } = setup(async (url) => {
      expect(url).toBe(`${ORIGIN}/m/app`);
      return htmlResponse();
    });
    const hung = deferred<void>();
    canonical.putImpl = () => hung.promise;

    const warmP = createWarmCanonical(deps)();
    const outcome = expect(warmP).rejects.toThrow(
      `deadline of ${WARM_DEADLINE_MS}ms exceeded`,
    );
    await jest.advanceTimersByTimeAsync(WARM_DEADLINE_MS);
    await outcome;
    expect(log).toHaveBeenCalledWith('canonical warm failed', expect.anything());

    hung.resolve();
    await flushMicrotasks();
    expect(log).toHaveBeenCalledWith('disowned work settled after its deadline');
  });

  it('redirected in-scope warm pins the normalized copy (pre-copy validation)', async () => {
    const finalUrl = `${ORIGIN}/m/app`;
    const { deps, canonical, copied } = setup(async () =>
      redirectedTo(finalUrl),
    );

    await createWarmCanonical(deps)();

    expect(copied).toEqual([{ url: finalUrl, redirected: true }]);
    expect(canonical.store.get(CANONICAL_URL)?.body).toBe(SHELL_HTML);
  });

  it.each([
    ['off-scope redirect', () => redirectedTo(`${ORIGIN}/login`), 'off-scope'],
    ['non-HTML', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), 'warm failed'],
    ['non-ok', () => htmlResponse('x', { status: 503 }), 'warm failed'],
  ])('%s: rejects and pins nothing', async (_label, make, message) => {
    const { deps, canonical, log } = setup(async () => make());

    await expect(createWarmCanonical(deps)()).rejects.toThrow(message);
    expect(canonical.puts).toHaveLength(0);
    expect(log).toHaveBeenCalledWith('canonical warm failed', expect.anything());
  });
});
