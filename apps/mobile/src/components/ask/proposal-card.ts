import {
  AI_TOOL_MODES,
  type AiToolMode,
  type ChatToolCallDto,
} from '@weavestream/shared';

/**
 * Display data for the read-only proposal cards ("Review and apply on
 * desktop" — mobile wires no Apply/Reject in v1, by decision).
 *
 * Two traps this helper exists to absorb:
 *
 *  - The `tool_call` event carries EVERY tool call attached to the
 *    turn, including executed/failed READ tools (search, get_article).
 *    Only proposal-mode tools (`AI_TOOL_MODES`) become cards — a
 *    completed search rendered as "review on desktop" would be a lie.
 *  - `arguments` is whatever JSON the LLM produced; the schema
 *    deliberately admits malformed output so a broken call can still be
 *    persisted and rejected (chat.ts). Every read is runtime-narrowed —
 *    an `arguments.title` that isn't a string must not crash the
 *    transcript.
 */

export interface ProposalCardData {
  id: string;
  /** "Drafted an article" / "Drafted an edit". */
  headline: string;
  /** The proposed title, when the model supplied a usable one. */
  title: string | null;
}

const PROPOSAL_HEADLINES: Partial<Record<string, string>> = {
  create_article: 'Drafted an article',
  update_article: 'Drafted an article edit',
  patch_article: 'Drafted an article edit',
};

export function proposalCards(
  toolCalls: readonly ChatToolCallDto[],
): ProposalCardData[] {
  return toolCalls.flatMap((call) => {
    const mode = (AI_TOOL_MODES as Partial<Record<string, AiToolMode>>)[
      call.name
    ];
    if (mode !== 'proposal') return [];
    return [
      {
        id: call.id,
        headline: PROPOSAL_HEADLINES[call.name] ?? 'Drafted a change',
        title: extractTitle(call.arguments),
      },
    ];
  });
}

function extractTitle(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null;
  const title = (args as Record<string, unknown>).title;
  return typeof title === 'string' && title.trim() ? title.trim() : null;
}
