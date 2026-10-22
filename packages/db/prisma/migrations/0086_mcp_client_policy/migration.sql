-- Remote MCP: which AI apps may connect. Existing instances keep today's
-- rule (only claude.ai and ChatGPT) through the default.
ALTER TABLE "system_settings"
    ADD COLUMN "mcp_client_policy" TEXT NOT NULL DEFAULT 'claude_chatgpt';

ALTER TABLE "system_settings"
    ADD CONSTRAINT "system_settings_mcp_client_policy_check"
    CHECK ("mcp_client_policy" IN ('claude_chatgpt', 'any'));
