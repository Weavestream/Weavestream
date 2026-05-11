-- Agentic article edits: each assistant turn may include zero or more
-- tool calls that the user reviews via an Apply / Reject gate in the
-- chat. We store the array on the message row (JSONB) so reload after
-- the stream completed still shows the pending action card. Shape:
--   [{
--     id: string,           -- LLM-supplied tool call id
--     name: 'update_article' | 'create_article',
--     arguments: object,    -- parsed args object (markdown body etc.)
--     status: 'pending' | 'applied' | 'rejected' | 'failed',
--     result: string | null,  -- short summary on apply
--     error: string | null    -- failure reason on apply
--   }]
ALTER TABLE "chat_messages"
    ADD COLUMN "tool_calls" JSONB;
