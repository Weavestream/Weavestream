/**
 * OpenAI-style tool catalog exposed to the LLM during a chat turn —
 * DERIVED from the typed registry (`ai-tools/tool-specs.ts`), whose
 * Zod input schemas are the single source of truth shared with
 * execution- and apply-time validation. The previous hand-written
 * catalog lives on, frozen, in `ai-tools/zod-openai.spec.ts` as the
 * byte-parity contract for the converter.
 *
 * Design notes:
 *
 * - Two tool modes (WS-030). `read` tools (`search`, `get_article`,
 *   `get_related_items`, `get_company_summary`) EXECUTE server-side
 *   during the streaming loop, behind the acting user's own
 *   permissions. `proposal` tools (`update_article`, `create_article`)
 *   still never execute when emitted; the chat UI renders an Apply /
 *   Reject card and the user confirms.
 *
 * - The LLM never picks a `company_id`. Read tools derive scope from
 *   entity rows + the trusted turn context; apply-time wiring takes
 *   the company from the request scope so a hallucinated id can never
 *   mutate the wrong tenant.
 *
 * - Schemas are `strict: true` with EVERY property listed in `required`
 *   and optional fields typed as a `["…","null"]` union. On vLLM this
 *   opts the `tool_choice: 'auto'` path into structural-tag constraints
 *   (without `strict` the args are scraped from raw text and can be
 *   malformed). The model emits `null` for fields it doesn't set; the
 *   execution/apply paths normalise `null → undefined` before
 *   re-validating against the shared Zod schemas, which enforce the
 *   real required set.
 */
import {
  AI_TOOL_MODES,
  aiToolNames,
  type AiToolName,
} from '@weavestream/shared';
import { AI_TOOL_SPECS } from '../ai-tools/tool-specs.js';
import { toOpenAiToolDef, type OpenAiFunctionTool } from '../ai-tools/zod-openai.js';

export type ToolDef = OpenAiFunctionTool;

/** The full catalog, converted once at module load. */
export const CHAT_TOOL_DEFS: ToolDef[] = aiToolNames.map((name) =>
  toOpenAiToolDef(AI_TOOL_SPECS[name]),
);

export const READ_TOOL_DEFS: ToolDef[] = CHAT_TOOL_DEFS.filter(
  (t) => AI_TOOL_MODES[t.function.name as AiToolName] === 'read',
);
export const PROPOSAL_TOOL_DEFS: ToolDef[] = CHAT_TOOL_DEFS.filter(
  (t) => AI_TOOL_MODES[t.function.name as AiToolName] === 'proposal',
);

export function isKnownToolName(name: string): name is AiToolName {
  return (aiToolNames as readonly string[]).includes(name);
}

export function isReadToolName(name: string): name is AiToolName {
  return isKnownToolName(name) && AI_TOOL_MODES[name] === 'read';
}

export function isProposalToolName(name: string): name is AiToolName {
  return isKnownToolName(name) && AI_TOOL_MODES[name] === 'proposal';
}

/**
 * OpenAI `tool_choice` shapes we emit. `'none'` suppresses tool calls,
 * `'auto'` lets the model self-select (constrained by the `strict`
 * schemas above), and the named-function form forces exactly one tool —
 * on vLLM that applies structured-output constraints by default, the
 * strongest portable reliability lever.
 */
export type ToolChoice =
  | 'none'
  | 'auto'
  | { type: 'function'; function: { name: AiToolName } };

/** The subset of the catalog matching the given names, in catalog order. */
export function toolDefsFor(names: readonly AiToolName[]): ToolDef[] {
  return CHAT_TOOL_DEFS.filter((t) =>
    names.includes(t.function.name as AiToolName),
  );
}

/**
 * Read tools available for a turn. `get_company_summary` is only
 * meaningful (and only resolvable) on a company-scoped chat — its
 * scope comes exclusively from the turn context.
 */
export function readToolDefs(hasCompany: boolean): ToolDef[] {
  return hasCompany
    ? READ_TOOL_DEFS
    : toolDefsFor([
        'search',
        'find_related_items',
        'get_article',
        'get_related_items',
        'get_app_help',
      ]);
}
