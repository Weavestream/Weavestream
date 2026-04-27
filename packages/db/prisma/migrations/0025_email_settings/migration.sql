-- Global SMTP settings. The password is stored as AES-256-GCM ciphertext
-- using SMTP_SECRET_KEY and is never returned by the API.

CREATE TYPE "SmtpSecurityMode" AS ENUM ('STARTTLS', 'TLS', 'NONE');

CREATE TABLE "email_settings" (
    "id"                  TEXT               NOT NULL DEFAULT 'singleton',
    "enabled"             BOOLEAN            NOT NULL DEFAULT false,
    "host"                TEXT,
    "port"                INTEGER,
    "secure_mode"         "SmtpSecurityMode" NOT NULL DEFAULT 'STARTTLS',
    "username"            TEXT,
    "password_ciphertext" TEXT,
    "from_name"           TEXT,
    "from_email"          TEXT,
    "reply_to"            TEXT,
    "updated_at"          TIMESTAMP(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by"          UUID,

    CONSTRAINT "email_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "email_settings" ("id")
VALUES ('singleton')
ON CONFLICT ("id") DO NOTHING;
