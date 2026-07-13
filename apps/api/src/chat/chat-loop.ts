/**
 * Pure decision logic + injectable driver for the bounded read-tool
 * loop (WS-030). Kept out of {@link ChatStreamService} in the style of
 * `chat-turn.ts` so every branch of the loop is unit-testable with
 * fakes — no SSE, no DB, no network.
 *
 * Shape of a turn:
 *   round 1..MAX_TOOL_ROUNDS  — completions with tools offered; read
 *                               calls execute sequentially between
 *                               rounds and their results are fed back
 *                               as `role:'tool'` messages.
 *   round MAX_COMPLETIONS     — forced-final: no `tools` key at all,
 *                               the model must answer with what it has.
 *
 * Proposal tools NEVER execute here; they become pending Apply/Reject
 * cards (or are deferred to the next round when mixed with reads, so
 * the re-proposal is grounded in the read results and no duplicate
 * cards render).
 */
import type { ChatToolCallDto } from '@weavestream/shared';
import type { AiToolExecutionResult } from '../ai-tools/ai-tool-executor.service.js';
import {
  isProposalToolName,
  isReadToolName,
  readToolDefs,
  toolDefsFor,
  type ToolChoice,
  type ToolDef,
} from './chat-tools.js';
import { estimateTokens } from './chat-turn.js';

/** Completions in which tools are offered. */
export const MAX_TOOL_ROUNDS = 2;
/** Total read executions per assistant turn (composes with the Redis budget). */
export const MAX_READ_CALLS = 5;
/** Hard cap on completions: MAX_TOOL_ROUNDS + one forced-final round. */
export const MAX_COMPLETIONS = MAX_TOOL_ROUNDS + 1;
/** Don't start another round with less wall-clock than this left. */
export const MIN_NEXT_ROUND_MS = 5_000;
/** Per-result clamp before a tool payload goes back to the model. */
export const TOOL_RESULT_MAX_CHARS = 24_000;
/** Never clamp a tool result below this floor. */
export const TOOL_RESULT_MIN_CHARS = 1_000;

export const TOOL_MSG_INVALID_ARGS = 'Invalid tool arguments.';
export const TOOL_MSG_LIMIT_REACHED =
  'Tool limit reached for this reply. Answer using what was already retrieved.';
export const TOOL_MSG_PROPOSAL_DEFERRED =
  'Not executed. After reviewing the tool results, propose it again and the user will see an Apply card.';
export const READ_FAILED_LIMIT_MESSAGE =
  'Not executed — the tool limit for this reply was reached.';
export const NO_BASE_BLOCK_MESSAGE =
  'The assistant proposed editing an article it hadn’t read this turn, ' +
  'so the proposal was blocked. Ask it to read the article first.';
export const PATCH_TARGET_UNAVAILABLE_MESSAGE =
  'The requested article could not be found or is not accessible, so the edit was not proposed.';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A finalized tool call plus the raw arguments blob, needed to echo
 *  the call back upstream verbatim in the assistant message. */
export type FinalizedToolCall = ChatToolCallDto & { rawArguments: string };

/** OpenAI chat message, extended with the tool-protocol fields. */
export interface UpstreamMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export function partitionToolCalls(calls: FinalizedToolCall[]): {
  /** Well-formed read calls, in emission order. */
  reads: FinalizedToolCall[];
  /** Well-formed proposal calls. */
  proposals: FinalizedToolCall[];
  /** Calls finalize() already marked failed (malformed/empty/truncated). */
  malformed: FinalizedToolCall[];
} {
  const reads: FinalizedToolCall[] = [];
  const proposals: FinalizedToolCall[] = [];
  const malformed: FinalizedToolCall[] = [];
  for (const call of calls) {
    if (call.status !== 'pending') malformed.push(call);
    else if (isReadToolName(call.name)) reads.push(call);
    else if (isProposalToolName(call.name)) proposals.push(call);
  }
  return { reads, proposals, malformed };
}

/** Tool set for rounds after the first. Reads stay on the menu while
 *  the per-turn allowance lasts; article edit tools appear once ANY
 *  article basis has been captured this turn (attached with a
 *  confirmed revision claim, or read via `get_article`); create needs
 *  a company scope, exactly like apply time. */
export function roundTools(input: {
  readBudget: number;
  hasCompany: boolean;
  anyBasisCaptured: boolean;
}): { tools: ToolDef[]; toolChoice: ToolChoice } {
  const tools: ToolDef[] = [
    ...(input.readBudget > 0 ? readToolDefs(input.hasCompany) : []),
    ...(input.anyBasisCaptured ? toolDefsFor(['patch_article', 'update_article']) : []),
    ...(input.hasCompany ? toolDefsFor(['create_article']) : []),
  ];
  return { tools, toolChoice: 'auto' };
}

/** '\n\n'-joined round texts; empty pieces vanish. */
export function joinRoundText(before: string, roundText: string): string {
  if (!roundText) return before;
  if (!before) return roundText;
  return `${before.replace(/\s+$/, '')}\n\n${roundText}`;
}

export function remainingMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

/** Clamp a tool payload; the marker keeps the truncation honest to the model. */
export function clampToolResult(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}…[truncated]`, truncated: true };
}

/**
 * A `get_article` read may establish an update basis only when the
 * model received a complete, schema-valid article body. Chunked reads
 * (`truncated: true`) intentionally do not qualify: the rewrite tool
 * replaces the whole body, and the patch tool must still anchor its
 * exact text to one confirmed article revision.
 */
export function completeArticleReadBasis(
  result: AiToolExecutionResult & { ok: true },
): { articleId: string; revision: number } | null {
  const output = result.output as {
    id?: unknown;
    revision?: unknown;
    truncated?: unknown;
  };
  if (
    typeof output.id !== 'string' ||
    typeof output.revision !== 'number' ||
    !Number.isInteger(output.revision) ||
    output.revision < 1 ||
    output.truncated !== false
  ) {
    return null;
  }
  return { articleId: output.id, revision: output.revision };
}

/**
 * Per-round allowance for one tool result, given what the prompt
 * already holds. Uses the same cheap char-based estimate as budgeting;
 * never below the floor so a crowded prompt still gets a usable result.
 */
export function fitToolResultChars(input: {
  contextWindowTokens: number;
  maxOutputTokens: number;
  messages: ReadonlyArray<UpstreamMessage>;
}): number {
  const used = input.messages.reduce(
    (a, m) =>
      a +
      estimateTokens(m.content ?? '') +
      (m.tool_calls?.reduce((b, t) => b + estimateTokens(t.function.arguments), 0) ?? 0),
    0,
  );
  const remainingTokens = Math.max(0, input.contextWindowTokens - input.maxOutputTokens - used);
  return Math.max(TOOL_RESULT_MIN_CHARS, Math.min(TOOL_RESULT_MAX_CHARS, remainingTokens * 4));
}

export function assistantToolCallMessage(
  text: string,
  calls: FinalizedToolCall[],
): UpstreamMessage {
  return {
    role: 'assistant',
    // Some servers reject an empty string next to tool_calls; null is
    // the portable spelling of "no visible text this round".
    content: text || null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: 'function' as const,
      function: { name: c.name, arguments: c.rawArguments },
    })),
  };
}

export function toolResultMessage(toolCallId: string, content: string): UpstreamMessage {
  return { role: 'tool', tool_call_id: toolCallId, content };
}

// ----------------------------------------------------------------------
// Driver
// ----------------------------------------------------------------------

export interface RoundResult {
  text: string;
  finishReason: string | null;
  toolCalls: FinalizedToolCall[];
}

export interface ToolLoopDeps {
  /**
   * Run one upstream completion, streaming deltas to the client as
   * they arrive. `tools`/`toolChoice` are null on the forced-final
   * round (omit the keys entirely). `leadingSeparator` asks the caller
   * to emit a '\n\n' delta before this round's first text so
   * multi-round replies render as paragraphs, matching the persisted
   * `joinRoundText` output.
   */
  callRound(
    round: number,
    messages: ReadonlyArray<UpstreamMessage>,
    tools: ToolDef[] | null,
    toolChoice: ToolChoice | null,
    opts: { leadingSeparator: boolean },
  ): Promise<RoundResult>;
  /** Execute one read tool (never throws — see AiToolExecutorService). */
  executeRead(call: FinalizedToolCall): Promise<AiToolExecutionResult>;
  /** Called when a read result validated OK (records article bases etc.). */
  onReadResult(call: FinalizedToolCall, result: AiToolExecutionResult & { ok: true }): void;
  onToolActivity(call: FinalizedToolCall, status: 'started' | 'succeeded' | 'failed'): void;
  onNotice(message: string): void;
  now(): number;
}

export interface ToolLoopInput {
  /** Prompt assembled by the caller; the loop appends tool rounds. */
  messages: UpstreamMessage[];
  /** Round-1 routing from resolveTurnTools. */
  tools: ToolDef[];
  toolChoice: ToolChoice;
  hasCompany: boolean;
  /** True once any article basis is captured this turn (live view). */
  anyBasisCaptured(): boolean;
  deadline: number;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ToolLoopOutcome {
  text: string;
  finishReason: string | null;
  /** Executed / failed read calls plus malformed calls, emission order. */
  settledCalls: ChatToolCallDto[];
  /** Well-formed proposals from the FINAL round only (deferred earlier
   *  rounds never persist). baseRevision assignment is the caller's. */
  proposals: FinalizedToolCall[];
}

export async function runToolLoop(
  deps: ToolLoopDeps,
  input: ToolLoopInput,
): Promise<ToolLoopOutcome> {
  const settledCalls: ChatToolCallDto[] = [];
  let text = '';
  let finishReason: string | null = null;
  let readBudget = MAX_READ_CALLS;
  let budgetNoticeSent = false;

  for (let round = 1; round <= MAX_COMPLETIONS; round++) {
    const isToolRound = round <= MAX_TOOL_ROUNDS;
    const routed =
      round === 1
        ? { tools: input.tools, toolChoice: input.toolChoice }
        : isToolRound
          ? roundTools({
              readBudget,
              hasCompany: input.hasCompany,
              anyBasisCaptured: input.anyBasisCaptured(),
            })
          : { tools: [] as ToolDef[], toolChoice: 'none' as ToolChoice };
    const offerTools = routed.tools.length > 0 && routed.toolChoice !== 'none';

    const result = await deps.callRound(
      round,
      input.messages,
      offerTools ? routed.tools : null,
      offerTools ? routed.toolChoice : null,
      { leadingSeparator: text.length > 0 },
    );
    finishReason = result.finishReason;
    text = joinRoundText(text, result.text);

    const { reads, proposals, malformed } = partitionToolCalls(result.toolCalls);
    if (reads.length === 0) {
      // Plain answer, or proposals only — the turn is done. Malformed
      // calls persist as failed exactly as the single-round flow did.
      settledCalls.push(...malformed.map(stripRaw));
      return { text, finishReason, settledCalls, proposals };
    }

    const timeLeft = remainingMs(input.deadline, deps.now());
    const roundsLeft = round < MAX_TOOL_ROUNDS;
    const canContinue = timeLeft >= MIN_NEXT_ROUND_MS;

    if (!canContinue) {
      // No wall-clock left to feed results back — executing would be
      // wasted work the model never sees.
      deps.onNotice('Ran out of time for tool lookups — answering with what was retrieved.');
      settledCalls.push(...malformed.map(stripRaw), ...reads.map(limitFailedDto));
      return { text, finishReason, settledCalls, proposals };
    }

    if (!roundsLeft) {
      if (proposals.length > 0) {
        // Final tool round emitted proposals alongside reads: the user
        // has visible output (text + cards); no third completion.
        settledCalls.push(...malformed.map(stripRaw), ...reads.map(limitFailedDto));
        return { text, finishReason, settledCalls, proposals };
      }
      // Reads only at the bound → force-final round with no tools.
      input.messages.push(assistantToolCallMessage(result.text, result.toolCalls));
      for (const call of result.toolCalls) {
        input.messages.push(
          toolResultMessage(
            call.id,
            call.status !== 'pending' ? TOOL_MSG_INVALID_ARGS : TOOL_MSG_LIMIT_REACHED,
          ),
        );
      }
      settledCalls.push(...malformed.map(stripRaw), ...reads.map(limitFailedDto));
      continue;
    }

    // Execute-and-continue. Echo the round's calls, then answer every
    // single one (protocol validity), executing reads up to the budget.
    input.messages.push(assistantToolCallMessage(result.text, result.toolCalls));
    const toExecute = new Set(reads.slice(0, Math.max(0, readBudget)));
    for (const call of result.toolCalls) {
      if (call.status !== 'pending') {
        input.messages.push(toolResultMessage(call.id, TOOL_MSG_INVALID_ARGS));
        settledCalls.push(stripRaw(call));
        continue;
      }
      if (isProposalToolName(call.name)) {
        // Deferred — NOT persisted; the model re-proposes next round.
        input.messages.push(toolResultMessage(call.id, TOOL_MSG_PROPOSAL_DEFERRED));
        continue;
      }
      if (!toExecute.has(call)) {
        input.messages.push(toolResultMessage(call.id, TOOL_MSG_LIMIT_REACHED));
        settledCalls.push(limitFailedDto(call));
        continue;
      }

      deps.onToolActivity(call, 'started');
      readBudget--;
      const outcome = await deps.executeRead(call);
      if (outcome.ok) {
        const allowance = fitToolResultChars({
          contextWindowTokens: input.contextWindowTokens,
          maxOutputTokens: input.maxOutputTokens,
          messages: input.messages,
        });
        const clamped = clampToolResult(outcome.payloadJson, allowance);
        if (clamped.truncated) {
          deps.onNotice('A tool result was truncated to fit the model’s limit.');
        } else {
          // The hook can establish an article-update basis. Call it
          // only after the exact, complete JSON payload has been queued
          // for the model; never grant a basis from a sliced payload.
          deps.onReadResult(call, outcome);
        }
        input.messages.push(toolResultMessage(call.id, clamped.text));
        settledCalls.push({
          ...stripRaw(call),
          status: 'executed',
          result: outcome.summary,
          error: null,
          errorCode: null,
        });
        deps.onToolActivity(call, 'succeeded');
      } else {
        input.messages.push(toolResultMessage(call.id, outcome.error));
        settledCalls.push({
          ...stripRaw(call),
          status: 'failed',
          result: null,
          error: outcome.error,
          errorCode: outcome.errorCode,
        });
        deps.onToolActivity(call, 'failed');
        if (outcome.errorCode === 'budget' && !budgetNoticeSent) {
          budgetNoticeSent = true;
          const minutes = Math.max(1, Math.ceil((outcome.retryAfterSeconds ?? 3600) / 60));
          deps.onNotice(`AI tool budget reached — more lookups available in about ${minutes} min.`);
        }
      }
    }
  }

  // MAX_COMPLETIONS exhausted; the forced-final round can't emit tool
  // calls (none were offered), so this is only reachable when the
  // final round returned reads==0 — handled above. Defensive return.
  return { text, finishReason, settledCalls, proposals: [] };
}

// ----------------------------------------------------------------------
// Persist-time revision binding (capture points feed these; nothing is
// looked up fresh at persist time — a DB read here could refresh a
// stale basis, the exact TOCTOU the captured map exists to prevent).
// ----------------------------------------------------------------------

/**
 * Capture point (a): an attached snapshot's basis is confirmable only
 * when the CLIENT-claimed revision (what the snapshot body was based
 * on) equals the current row. A mismatch means someone saved a newer
 * revision after the client fetched; a missing claim (old client)
 * means the basis is unknowable. Neither may be captured — recording
 * the DB's current revision for either would let Apply overwrite an
 * edit the model never saw.
 */
export function confirmedSnapshotBases(
  claims: ReadonlyArray<{ id: string; revision?: number }>,
  currentRevisionById: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const claim of claims) {
    if (
      typeof claim.revision === 'number' &&
      currentRevisionById.get(claim.id) === claim.revision
    ) {
      out.set(claim.id, claim.revision);
    }
  }
  return out;
}

/**
 * baseRevision assignment for the FINAL round's article proposals:
 *   captured basis   → pending, guarded at apply on that revision
 *   uncaptured but the article resolves in the actor's scope
 *                    → BLOCKED (failed/no_base): the model proposed an
 *                      edit to content it never saw this turn
 *   does not resolve → pending with baseRevision null, serving ONLY
 *                      the Save-as-article create promotion
 */
export async function assignProposalBases(
  proposals: FinalizedToolCall[],
  captured: ReadonlyMap<string, number>,
  articleResolvesInScope: (articleId: string) => Promise<boolean>,
): Promise<ChatToolCallDto[]> {
  const out: ChatToolCallDto[] = [];
  for (const proposal of proposals) {
    const dto = stripRaw(proposal);
    if (proposal.name !== 'patch_article' && proposal.name !== 'update_article') {
      out.push(dto);
      continue;
    }
    const articleId =
      typeof proposal.arguments['article_id'] === 'string'
        ? proposal.arguments['article_id']
        : null;
    if (articleId && captured.has(articleId)) {
      out.push({ ...dto, baseRevision: captured.get(articleId)! });
      continue;
    }
    const resolves =
      articleId && UUID_RE.test(articleId) ? await articleResolvesInScope(articleId) : false;
    if (resolves) {
      out.push({
        ...dto,
        status: 'failed',
        result: null,
        errorCode: 'no_base',
        error: NO_BASE_BLOCK_MESSAGE,
      });
    } else if (proposal.name === 'patch_article') {
      out.push({
        ...dto,
        status: 'failed',
        result: null,
        errorCode: 'unavailable',
        error: PATCH_TARGET_UNAVAILABLE_MESSAGE,
      });
    } else {
      out.push({ ...dto, baseRevision: null });
    }
  }
  return out;
}

function stripRaw(call: FinalizedToolCall): ChatToolCallDto {
  const { rawArguments: _raw, ...dto } = call;
  return dto;
}

function limitFailedDto(call: FinalizedToolCall): ChatToolCallDto {
  return {
    ...stripRaw(call),
    status: 'failed',
    result: null,
    error: READ_FAILED_LIMIT_MESSAGE,
    errorCode: 'budget',
  };
}
