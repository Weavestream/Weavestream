import { Injectable } from '@nestjs/common';
import type {
  GetAppHelpToolInput,
  GetAppHelpToolOutput,
} from '@weavestream/shared';
import { AppHelpService } from '../../ai-help/app-help.service.js';
import { AI_TOOL_SPECS } from '../tool-specs.js';
import type { AiReadTool, AiToolExecutionContext } from '../tool-registry.js';

@Injectable()
export class GetAppHelpAiTool implements AiReadTool {
  readonly spec = AI_TOOL_SPECS.get_app_help;

  constructor(private readonly help: AppHelpService) {}

  async resolveCompanyId(ctx: AiToolExecutionContext): Promise<'self-scoped' | null> {
    // Defense-in-depth (CLAUDE.md §7): app-help is not offered to
    // CLIENT_USER (portal role) — the corpus is admin/operator how-to
    // they can't act on (F13) — but the model is not a trusted principal,
    // so deny at execution too. `null` routes to the shared unavailable
    // outcome, indistinguishable from not-found (non-enumeration).
    if (ctx.actor.role === 'CLIENT_USER') return null;
    return 'self-scoped';
  }

  async execute(
    _ctx: AiToolExecutionContext,
    args: Record<string, unknown>,
  ): Promise<GetAppHelpToolOutput> {
    const input = args as GetAppHelpToolInput;
    return this.help.search(input.question);
  }
}
