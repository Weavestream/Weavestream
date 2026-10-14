import { createServer, type IncomingMessage, type RequestListener, type Server } from 'node:http';

/**
 * The API's second, internal HTTP listener. It serves the same Express app as
 * the public port, but only on loopback, and every request that arrives
 * through it carries {@link INTERNAL_LISTENER}.
 *
 * The remote MCP endpoint makes its tool calls here, with single-use
 * delegation handles (`Bearer wsd_…`) that `AuthGuard` accepts only on
 * requests carrying the marker. A socket-peer check could not do that job:
 * the web container proxies to the public port, and in development or a
 * single-host install that proxy is itself a loopback peer (the same lesson
 * as `internal-only.guard.ts`). The web container proxies only to the public
 * port and this one is never published, so nothing from outside the process
 * reaches it.
 */
export const INTERNAL_LISTENER_HOST = '127.0.0.1';
export const INTERNAL_LISTENER_PORT = 4001;
export const INTERNAL_LISTENER_ORIGIN = `http://${INTERNAL_LISTENER_HOST}:${INTERNAL_LISTENER_PORT}`;

/** Set only by the internal listener; no network input can produce a Symbol key. */
const INTERNAL_LISTENER: unique symbol = Symbol('weavestream.internalListener');

type Marked = IncomingMessage & { [INTERNAL_LISTENER]?: true };

/** True only for a request that arrived through the internal listener. */
export function isInternalListenerRequest(req: IncomingMessage): boolean {
  return (req as Marked)[INTERNAL_LISTENER] === true;
}

/** Wrap a request handler so every request it serves is marked internal. */
export function internalListenerHandler(app: RequestListener): RequestListener {
  return (req, res) => {
    (req as Marked)[INTERNAL_LISTENER] = true;
    app(req, res);
  };
}

/** Start the internal listener on loopback; resolves once it is listening. */
export function startInternalListener(
  app: RequestListener,
  port: number = INTERNAL_LISTENER_PORT,
): Promise<Server> {
  const server = createServer(internalListenerHandler(app));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, INTERNAL_LISTENER_HOST, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
