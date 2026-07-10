import type { ChatTurnContext, TenantContext } from '@weavestream/shared';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { AiToolSpec } from './tool-specs.js';
import { AI_TOOL_SPECS } from './tool-specs.js';

/**
 * Server-only context a read tool executes with. Assembled by the chat
 * stream handler once per turn; the model contributes NOTHING to it.
 */
export interface AiToolExecutionContext {
  actor: AuthedUser;
  /** From `requireTenantContext()` at turn start. */
  tenant: TenantContext;
  /** Request correlation id (`tenant.requestId`) — audited, never content. */
  correlationId: string;
  ip: string;
  userAgent: string;
  /** Conversation the turn belongs to — keys the per-conversation budget. */
  conversationId: string;
  /**
   * The turn's persisted scope snapshot. ADVISORY ONLY — a company id
   * in here narrows what a tool looks at (e.g. which company a search
   * defaults to), but authorization always derives from entity rows +
   * PermissionService.
   */
  turnContext: ChatTurnContext | null;
}

/**
 * A read-mode tool implementation. Executed by `AiToolExecutorService`
 * which owns validation, scoping, permission checks, output validation
 * and auditing — implementations only load data via existing services
 * (which re-enforce visibility at the query layer: defense in depth).
 */
export interface AiReadTool {
  readonly spec: AiToolSpec;
  /**
   * Resolve the companyId the entry-gate permission check runs
   * against, from server-derived data only (entity row lookup or turn
   * context). Return `null` for not-found/out-of-scope (the executor
   * emits the generic error) or `'self-scoped'` when the tool scopes
   * itself at the query layer (spec.permission must be null).
   */
  resolveCompanyId(
    ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<string | null | 'self-scoped'>;
  /**
   * Execute with already-validated args and the company resolved by
   * `resolveCompanyId` (`null` for self-scoped tools). May throw
   * NotFound/Forbidden (converted to the generic error) — anything
   * else is logged as an internal error. The result is validated
   * against `spec.outputSchema` before it reaches the model.
   */
  execute(
    ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
    companyId: string | null,
  ): Promise<unknown>;
}

/**
 * Boot-time-checked binding of specs to implementations. Constructed
 * once by `AiToolsModule`; a read spec without an implementation (or a
 * stray implementation whose spec isn't read-mode) fails module init
 * loudly instead of 500ing on first use.
 */
export class AiToolRegistry {
  private readonly readTools = new Map<string, AiReadTool>();

  constructor(readTools: AiReadTool[]) {
    for (const tool of readTools) {
      if (tool.spec.mode !== 'read') {
        throw new Error(
          `AiToolRegistry: "${tool.spec.name}" is registered as an executable ` +
            'read tool but its spec is proposal-mode.',
        );
      }
      if (this.readTools.has(tool.spec.name)) {
        throw new Error(`AiToolRegistry: duplicate read tool "${tool.spec.name}".`);
      }
      this.readTools.set(tool.spec.name, tool);
    }
    for (const spec of Object.values(AI_TOOL_SPECS)) {
      if (spec.mode === 'read' && !this.readTools.has(spec.name)) {
        throw new Error(
          `AiToolRegistry: read tool "${spec.name}" has a spec but no implementation.`,
        );
      }
    }
  }

  get(name: string): AiToolSpec | undefined {
    return (AI_TOOL_SPECS as Record<string, AiToolSpec>)[name];
  }

  getReadTool(name: string): AiReadTool | undefined {
    return this.readTools.get(name);
  }

  isRead(name: string): boolean {
    return this.get(name)?.mode === 'read';
  }

  isProposal(name: string): boolean {
    return this.get(name)?.mode === 'proposal';
  }
}
