---
label: Encryption
icon: lock
order: 700
description: Credential encryption, TOTP secrets, and key management in Weavestream.
---

# Encryption

Weavestream encrypts credential data at rest using AES-256-GCM with envelope encryption and key IDs for zero-downtime rotation.

## What Is Encrypted

| Data | Algorithm | Key variable |
|---|---|---|
| Password secrets | AES-256-GCM | `PASSWORD_ENCRYPTION_KEY` |
| TOTP secrets (vault) | AES-256-GCM | `PASSWORD_ENCRYPTION_KEY` |
| Password notes | AES-256-GCM | `PASSWORD_ENCRYPTION_KEY` |
| TOTP secrets (MFA) | AES-256-GCM | `MFA_ENCRYPTION_KEY` |

**Not encrypted at rest:**
- Password names, usernames, URLs, tags — stored in plaintext in Postgres (protected by database access controls)
- Article content — stored in plaintext (searchable by operators)
- Asset field values — stored in plaintext (indexed for search)

## Encryption Algorithm

All credential ciphertext uses **AES-256-GCM** (Authenticated Encryption with Associated Data):

- 256-bit key
- 96-bit random nonce per encryption operation (never reused)
- 128-bit authentication tag (detects tampering)

The algorithm provides both confidentiality and integrity. A tampered ciphertext will fail authentication and be rejected before decryption is attempted.

## Envelope Encryption and Key IDs

Each ciphertext blob is stored alongside the **key ID (`kid`)** used to encrypt it:

```
{
  "kid": "2026-01",
  "ciphertext": "<base64>",
  "nonce": "<base64>",
  "tag": "<base64>"
}
```

When decrypting:
1. Read the `kid` from the blob
2. Look up the corresponding key: check `PASSWORD_ENCRYPTION_KEY_KID` first, then `PASSWORD_PREVIOUS_KEYS`
3. Decrypt using the matched key

This allows the active key to be rotated without touching existing ciphertext. Old blobs continue to decrypt via the previous-keys list until they are re-encrypted under the new key.

## Key Rotation

See [Key Rotation](/configuration/key-rotation/) for the step-by-step procedure.

The `reencrypt-passwords` CLI command bulk-migrates all existing blobs to the current key:

```bash
docker compose exec api node dist/cli.js reencrypt-passwords
```

## TOTP Secret Encryption (MFA)

User MFA (two-factor authentication) TOTP secrets are encrypted under `MFA_ENCRYPTION_KEY`. This key is separate from the vault encryption key so that MFA credentials are protected independently.

TOTP secrets are only decrypted at login time (to validate the user's code) and during account management (to display the QR code during re-enrollment).

## Password Vault Reveal

When a user reveals a password:

1. The API fetches the ciphertext from Postgres
2. Decrypts using the key identified by `kid`
3. Returns the plaintext over the TLS connection (never stored in logs)
4. Writes a reveal event to the audit log

The plaintext secret is **never written to** Postgres (except as ciphertext), Redis, logs, or the audit log.

## Keys at Rest

Encryption keys live in the `.env` file on the Docker host. They are:

- Not stored in the database
- Not accessible through the Weavestream web UI or API
- Not transmitted to any external service

**Protect the `.env` file** with filesystem permissions (e.g. `chmod 600 .env`) and ensure it is included in your off-site backup (it cannot be recovered from the database).

## No Client-Side Encryption

Weavestream does not use end-to-end encryption (E2EE). Encryption is server-side: the API decrypts secrets in memory and transmits them to the browser over TLS. This means:

- The server (and anyone with access to the `.env` file) can decrypt all secrets
- The threat model assumes the server is trusted
- TLS must be properly configured to protect the decrypted secret in transit

For E2EE requirements, a dedicated password manager (Bitwarden, Vaultwarden) is a more appropriate solution.
