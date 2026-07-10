import { createHash } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { stripNullArgs } from '@weavestream/shared';
import type { AiToolName } from '@weavestream/shared';
import { PermissionService } from '../rbac/permission.service.js';
import { AuditLogService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit-actions.js';
import { AiToolBudgetService } from './ai-tool-budget.service.js';
import { AiToolRegistry } from './tool-registry.js';
import type { AiToolExecutionContext } from './tool-registry.js';

/**
 * One generic string for denied AND not-found — the model (and the
 * persisted DTO) must not be able to enumerate what exists. The audit
 * log records the true outcome.
 */
export const AI_TOOL_UNAVAILABLE_MESSAGE =
  'The requested item could not be found or is not accessible.';
export const AI_TOOL_INVALID_ARGS_MESSAGE = 'Invalid tool arguments.';
export const AI_TOOL_BUDGET_MESSAGE =
  'Tool budget reached for now — answer with what you already have.';

export type AiToolExecutionResult =
  | {
      ok: true;
      /** Schema-validated output object. */
      output: unknown;
      /** `JSON.stringify(output)` — what goes back to the model (after clamping). */
      payloadJson: string;
      /** One-line persisted summary from the spec. */
      summary: string;
    }
  | {
      ok: false;
      error: string;
      errorCode: 'unavailable' | 'malformed' | 'budget';
      /** Only set for budget denials. */
      retryAfterSeconds?: number;
    };

type AuditOutcome =
  | 'ok'
  | 'invalid_args'
  | 'budget_exhausted'
  | 'not_found'
  | 'denied'
  | 'error';

const AUDIT_ACTION_BY_TOOL: Record<AiToolName, string> = {
  // Proposal tools never reach the executor; mapped for completeness.
  update_article: AUDIT_ACTIONS.article.update,
  create_article: AUDIT_ACTIONS.article.create,
  search: AUDIT_ACTIONS.aiTool.search,
  find_related_items: AUDIT_ACTIONS.aiTool.findRelatedItems,
  get_article: AUDIT_ACTIONS.aiTool.getArticle,
  get_related_items: AUDIT_ACTIONS.aiTool.getRelatedItems,
  get_company_summary: AUDIT_ACTIONS.aiTool.getCompanySummary,
};

/**
 * Owns the full read-tool execution pipeline. NEVER throws — every
 * failure collapses into a structured result whose message is safe to
 * show to the model and persist on the tool-call DTO.
 *
 * Pipeline order is load-bearing:
 *   1. lookup (known read tool)
 *   2. validate args        — malformed calls never consume budget
 *   3. consume budget       — denied/not-found DO consume (probes burn
 *                             the prober's own budget)
 *   4. resolve company      — scope-safe, from server data only
 *   5. entry permission     — PermissionService.can on the resolved company
 *   6. execute              — services re-enforce visibility at the
 *                             query layer (defense in depth)
 *   7. validate output      — a service change can't silently leak new
 *                             fields into the LLM conversation
 *   8. audit                — EVERY exit path lands exactly one row
 */
@Injectable()
export class AiToolExecutorService {
  private readonly logger = new Logger(AiToolExecutorService.name);

  constructor(
    private readonly registry: AiToolRegistry,
    private readonly budget: AiToolBudgetService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditLogService,
  ) {}

  async executeRead(
    toolCallId: string,
    name: string,
    rawArgs: Record<string, unknown>,
    ctx: AiToolExecutionContext,
  ): Promise<AiToolExecutionResult> {
    const spec = this.registry.get(name);
    const tool = this.registry.getReadTool(name);
    if (!spec || !tool || spec.mode !== 'read') {
      // The stream loop only routes known read names here; a miss is a
      // programming error, not an enumeration surface.
      this.logger.error(`executeRead called for unknown/non-read tool "${name}"`);
      return {
        ok: false,
        error: AI_TOOL_UNAVAILABLE_MESSAGE,
        errorCode: 'unavailable',
      };
    }

    // One string for ALL of this tool's unavailable outcomes (not-found,
    // denied, internal error) — outcomes must stay indistinguishable to
    // the model even when a spec overrides the wording.
    const unavailableMessage = spec.unavailableMessage ?? AI_TOOL_UNAVAILABLE_MESSAGE;

    // 2. Validate BEFORE the budget — malformed calls are free.
    const parsed = spec.inputSchema.safeParse(stripNullArgs(rawArgs));
    if (!parsed.success) {
      await this.auditInvocation(spec.name, toolCallId, ctx, null, 'invalid_args', null);
      return {
        ok: false,
        error: AI_TOOL_INVALID_ARGS_MESSAGE,
        errorCode: 'malformed',
      };
    }
    const args = parsed.data as Record<string, unknown>;
    const argsSha256 = sha256CanonicalJson(args);

    // 3. Budget.
    const decision = await this.budget.consume(ctx.actor.id, ctx.conversationId);
    if (!decision.allowed) {
      await this.auditInvocation(
        spec.name,
        toolCallId,
        ctx,
        null,
        'budget_exhausted',
        argsSha256,
      );
      return {
        ok: false,
        error: AI_TOOL_BUDGET_MESSAGE,
        errorCode: 'budget',
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    }

    // 4. Scope resolution — never authorization by itself.
    let companyId: string | null = null;
    try {
      const resolved = await tool.resolveCompanyId(ctx, args);
      if (resolved === null) {
        await this.auditInvocation(
          spec.name,
          toolCallId,
          ctx,
          null,
          'not_found',
          argsSha256,
        );
        return {
          ok: false,
          error: unavailableMessage,
          errorCode: 'unavailable',
        };
      }
      companyId = resolved === 'self-scoped' ? null : resolved;

      // 5. Entry-gate permission on the resolved company.
      if (spec.permission !== null && resolved !== 'self-scoped') {
        const decision2 = await this.permissions.can(ctx.actor, spec.permission, {
          companyId: resolved,
        });
        if (!decision2.allowed) {
          await this.auditInvocation(
            spec.name,
            toolCallId,
            ctx,
            companyId,
            'denied',
            argsSha256,
          );
          return {
            ok: false,
            error: unavailableMessage,
            errorCode: 'unavailable',
          };
        }
      }

      // 6. Execute + 7. validate output.
      const output = await tool.execute(ctx, args, companyId);
      const outSchema = spec.outputSchema;
      if (outSchema === null) {
        throw new Error(`read tool "${spec.name}" has no output schema`);
      }
      const validated = outSchema.parse(output);
      const summary = spec.summarize
        ? spec.summarize(args, validated)
        : `Executed ${spec.name}`;

      await this.auditInvocation(spec.name, toolCallId, ctx, companyId, 'ok', argsSha256);
      return {
        ok: true,
        output: validated,
        payloadJson: JSON.stringify(validated),
        summary,
      };
    } catch (err) {
      const outcome: AuditOutcome =
        err instanceof NotFoundException
          ? 'not_found'
          : err instanceof ForbiddenException
            ? 'denied'
            : 'error';
      if (outcome === 'error') {
        this.logger.error(
          `AI tool "${spec.name}" failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        );
      }
      await this.auditInvocation(spec.name, toolCallId, ctx, companyId, outcome, argsSha256);
      return {
        ok: false,
        error: unavailableMessage,
        errorCode: 'unavailable',
      };
    }
  }

  /**
   * One append-only audit row per invocation, on every exit path.
   * Metadata only: outcome, correlation id, and a digest of the
   * VALIDATED args (null when validation never passed) — never raw
   * arguments, document content, or results.
   */
  private async auditInvocation(
    name: AiToolName,
    toolCallId: string,
    ctx: AiToolExecutionContext,
    companyId: string | null,
    outcome: AuditOutcome,
    argsSha256: string | null,
  ): Promise<void> {
    try {
      await this.audit.log({
        actorId: ctx.actor.id,
        action: AUDIT_ACTION_BY_TOOL[name],
        entityType: 'AiTool',
        entityId: toolCallId,
        companyId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        after: { outcome, correlationId: ctx.correlationId, argsSha256 },
      });
    } catch (err) {
      // Auditing must not turn a successful read into a failed one, but
      // a silent gap in the audit trail is worth an ERROR.
      this.logger.error(
        `Failed to audit AI tool invocation ${name}/${toolCallId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/** Stable digest: object keys sorted recursively before hashing. */
export function sha256CanonicalJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}
