import { Injectable } from '@nestjs/common';
import type { SearchToolInput, SearchToolOutput } from '@weavestream/shared';
import { SearchService } from '../../search/search.service.js';
import { AI_TOOL_SPECS } from '../tool-specs.js';
import type { AiReadTool, AiToolExecutionContext } from '../tool-registry.js';

/**
 * `search` — wraps the palette's `SearchService.search`, which derives
 * tenant scope from `requireTenantContext()` at the query layer
 * (allowedCompanyIds, client visibility, restricted-password
 * filtering). Self-scoped: no entry-gate company to check.
 *
 * When the chat was opened on a company page, results narrow to that
 * company (advisory scope — the service still enforces that the
 * company is within the actor's reach, returning nothing otherwise).
 */
@Injectable()
export class SearchAiTool implements AiReadTool {
  readonly spec = AI_TOOL_SPECS.search;

  constructor(private readonly search: SearchService) {}

  async resolveCompanyId(): Promise<'self-scoped'> {
    return 'self-scoped';
  }

  async execute(
    ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<SearchToolOutput> {
    const input = args as SearchToolInput;
    const result = await this.search.search(ctx.actor, {
      q: input.query,
      companyId: ctx.turnContext?.companyId,
      types: input.types,
      limit: Math.min(input.limit ?? 5, 10),
    });
    return {
      results: result.items.map((hit) => ({
        kind: hit.kind,
        id: hit.id,
        title: hit.title,
        snippet: plainSnippet(hit.snippet),
        companyName: hit.companyName,
        href: hit.href,
        updatedAt: hit.updatedAt,
      })),
    };
  }
}

/**
 * Snippets come HTML-escaped with `<mark>` highlight sentinels for the
 * palette's renderer. The model gets plain text: drop the marks, undo
 * the entity escaping.
 */
function plainSnippet(snippet: string): string {
  return snippet
    .replace(/<\/?mark>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
