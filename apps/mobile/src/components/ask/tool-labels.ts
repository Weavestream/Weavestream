import { type AiToolName } from '@weavestream/shared';

/**
 * `tool_activity` names → the transient "the assistant is looking
 * things up" line. Names only — the events never carry arguments or
 * results, and neither may the label.
 *
 * Table-driven port of the inline ternary in desktop's
 * `chat-panel-provider.tsx`; unknown names (a future tool this bundle
 * predates) fall back rather than crash.
 */
const TOOL_ACTIVITY_LABELS: Partial<Record<AiToolName, string>> = {
  search: 'Searching…',
  find_related_items: 'Checking linked items…',
  get_related_items: 'Checking linked items…',
  get_article: 'Reading an article…',
  get_company_summary: 'Summarizing the company…',
  get_app_help: 'Checking the help docs…',
};

export function toolActivityLabel(name: string): string {
  return (
    (TOOL_ACTIVITY_LABELS as Partial<Record<string, string>>)[name] ??
    'Looking things up…'
  );
}
