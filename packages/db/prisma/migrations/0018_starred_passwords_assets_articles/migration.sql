-- Phase 9b.3 expansion: per-user starring for passwords, assets, and articles.
-- Mirrors the StarredCompany pattern: one junction table per entity type
-- to preserve FK integrity and cascade-on-delete.

-- StarredPasswords
CREATE TABLE "starred_passwords" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "password_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "starred_passwords_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "starred_passwords_user_id_password_id_key" ON "starred_passwords"("user_id", "password_id");
CREATE INDEX "starred_passwords_user_id_created_at_idx" ON "starred_passwords"("user_id", "created_at");
ALTER TABLE "starred_passwords" ADD CONSTRAINT "starred_passwords_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "starred_passwords" ADD CONSTRAINT "starred_passwords_password_id_fkey"
    FOREIGN KEY ("password_id") REFERENCES "passwords"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- StarredAssets
CREATE TABLE "starred_assets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "asset_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "starred_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "starred_assets_user_id_asset_id_key" ON "starred_assets"("user_id", "asset_id");
CREATE INDEX "starred_assets_user_id_created_at_idx" ON "starred_assets"("user_id", "created_at");
ALTER TABLE "starred_assets" ADD CONSTRAINT "starred_assets_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "starred_assets" ADD CONSTRAINT "starred_assets_asset_id_fkey"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- StarredArticles
CREATE TABLE "starred_articles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "article_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "starred_articles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "starred_articles_user_id_article_id_key" ON "starred_articles"("user_id", "article_id");
CREATE INDEX "starred_articles_user_id_created_at_idx" ON "starred_articles"("user_id", "created_at");
ALTER TABLE "starred_articles" ADD CONSTRAINT "starred_articles_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "starred_articles" ADD CONSTRAINT "starred_articles_article_id_fkey"
    FOREIGN KEY ("article_id") REFERENCES "articles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
