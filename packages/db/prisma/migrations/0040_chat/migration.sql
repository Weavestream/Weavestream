-- Per-user AI chat conversations + messages. Scoped to a single user
-- (no company / tenant FK in this phase). Both tables cascade on user
-- deletion via the conversation FK.

CREATE TYPE "ChatRole" AS ENUM ('USER', 'ASSISTANT');

CREATE TABLE "chat_conversations" (
    "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
    "user_id"    UUID         NOT NULL,
    "title"      TEXT         NOT NULL DEFAULT 'New chat',
    "model"      TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_conversations_user_id_updated_at_idx"
    ON "chat_conversations" ("user_id", "updated_at");

ALTER TABLE "chat_conversations"
    ADD CONSTRAINT "chat_conversations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "chat_messages" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID         NOT NULL,
    "role"            "ChatRole"   NOT NULL,
    "content"         TEXT         NOT NULL,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "chat_messages_conversation_id_created_at_idx"
    ON "chat_messages" ("conversation_id", "created_at");

ALTER TABLE "chat_messages"
    ADD CONSTRAINT "chat_messages_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "chat_conversations" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
