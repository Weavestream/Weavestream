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

  async resolveCompanyId(): Promise<'self-scoped'> {
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
