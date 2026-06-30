-- Bind chat turns to the scope that produced them, and let an admin
-- size the LLM token budget.
--
-- `chat_messages.turn_context` stores a metadata-only snapshot of the
-- request scope (companyId, currentArticleId, attached article ids —
-- never markdown bodies) for the assistant turn that proposed an action.
-- Apply/follow-up read this instead of re-sampling whatever page is open
-- later. It is descriptive context only: apply still derives the
-- writable company from the article row for update_article and re-checks
-- article.write, so a stored/forged companyId can never widen scope.
-- Nullable + additive — legacy rows fall back to live page context.
ALTER TABLE "chat_messages"
ADD COLUMN "turn_context" JSONB;

-- Admin-tunable token limits for chat completions. Null falls back to a
-- conservative server default in code, so existing rows keep working
-- without a backfill. `max_output_tokens` caps the reply / reserves
-- output room for a full article rewrite; `context_window_tokens` sizes
-- the prompt budget so the reply fits the model's window.
ALTER TABLE "ai_settings"
ADD COLUMN "max_output_tokens" INTEGER;

ALTER TABLE "ai_settings"
ADD COLUMN "context_window_tokens" INTEGER;
