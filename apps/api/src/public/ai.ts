/** Supported API surface for `apps/worker`: AI completion. See `runtime.ts`. */
export { AiModule } from '../ai/ai.module.js';
export {
  AiCompletionHttpError,
  AiCompletionRefusedError,
  AiCompletionService,
  AiCompletionTruncatedError,
  describeCompletionHttpError,
  isContextLengthError,
  sanitizeAiSummary,
} from '../ai/ai-completion.service.js';
export {
  AiNotConfiguredError,
  AiSettingsService,
  type AiResolvedConfig,
} from '../ai/ai-settings.service.js';
export { backgroundOutputBudget } from '../ai/provider-http.js';
