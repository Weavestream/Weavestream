#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# Weavestream — key generator (macOS / Linux / WSL)
#
# Writes fresh random secrets to stdout in KEY=value form, ready to
# append to your .env file. Uses `openssl`, which ships with macOS and
# every mainstream Linux distribution.
#
#   ./scripts/keygen.sh >> .env
#
# Or copy individual lines into an existing .env that has placeholders.
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "error: openssl not found in PATH" >&2
  exit 1
fi

# URL-safe base64 (required for passwords that appear in DATABASE_URL /
# REDIS_URL — `+` and `/` break URL parsing).
urlsafe_b64() {
  openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '='
}

# 32-byte signing keys — standard base64 is fine; these are decoded
# server-side and never embedded in URLs.
cat <<EOF
JWT_SIGNING_KEY=$(openssl rand -base64 32)
MFA_ENCRYPTION_KEY=$(openssl rand -base64 32)
PASSWORD_ENCRYPTION_KEY=$(openssl rand -base64 32)
INTEGRATION_SECRET_KEY=$(openssl rand -base64 32)
SMTP_SECRET_KEY=$(openssl rand -base64 32)
COOKIE_SIGNING_KEY=$(openssl rand -base64 32)
CSRF_SIGNING_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(urlsafe_b64 24)
REDIS_PASSWORD=$(urlsafe_b64 24)
EOF
