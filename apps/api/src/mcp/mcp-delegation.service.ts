import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ToolHttpMethod } from '@weavestream/shared/mcp-tools';

/** Lifetime of a handle: one REST call, well inside the tool timeout. */
const HANDLE_TTL_MS = 30_000;
export const DELEGATION_PREFIX = 'wsd_';

export interface Delegation {
  connectionId: string;
  userId: string;
  method: ToolHttpMethod;
  /** Exact request path, e.g. `/api/v1/companies/<id>/assets`. */
  path: string;
  expiresAt: number;
}

/**
 * Single-use credentials for the remote MCP endpoint's own tool calls.
 *
 * The OAuth access token never leaves `/mcp` (no token passthrough): for
 * each tool call the endpoint mints a handle here — 32 random bytes, in this
 * process's memory only, valid for one method and one path, for 30 s, once —
 * and sends it to the internal listener. `AuthGuard` takes it out of the
 * store, so the REST call runs the full guard pipeline as the connection's
 * user and the handle can never be used again.
 *
 * Keyed by the random handle, never by user, so concurrent connections share
 * nothing.
 */
@Injectable()
export class McpDelegationService {
  private readonly handles = new Map<string, Delegation>();

  mint(grant: Omit<Delegation, 'expiresAt'>): string {
    this.sweep();
    const handle = `${DELEGATION_PREFIX}${randomBytes(32).toString('base64url')}`;
    this.handles.set(handle, { ...grant, expiresAt: Date.now() + HANDLE_TTL_MS });
    return handle;
  }

  /** Remove and return a live handle. A second take of the same handle finds nothing. */
  take(handle: string): Delegation | undefined {
    const found = this.handles.get(handle);
    if (!found) return undefined;
    this.handles.delete(handle);
    return found.expiresAt > Date.now() ? found : undefined;
  }

  /** Drop a handle that was never used (the call failed before reaching the API). */
  release(handle: string): void {
    this.handles.delete(handle);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [handle, d] of this.handles) if (d.expiresAt <= now) this.handles.delete(handle);
  }
}
