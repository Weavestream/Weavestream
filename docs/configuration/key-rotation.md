---
label: Key Rotation
icon: sync
order: 600
description: Rotate JWT signing keys and password encryption keys without downtime.
---

# Key Rotation

Weavestream supports zero-downtime key rotation for both JWT signing keys and password encryption keys. Old keys remain valid during the transition period; new tokens and ciphertext blobs are written under the new key immediately.

## JWT Signing Key Rotation

JWT keys sign the access tokens that authenticate API requests.

### Steps

1. **Generate a new key:**
   ```bash
   openssl rand -base64 32
   ```

2. **Update `.env`:**
   ```bash
   # Move the old key to the previous-keys list
   JWT_PREVIOUS_KEYS=<old-kid>:<old-key>
   
   # Set the new key and increment the KID
   JWT_SIGNING_KEY=<new-key>
   JWT_SIGNING_KEY_KID=2026-02   # bump this
   ```

3. **Restart the stack:**
   ```bash
   docker compose up -d
   ```

4. **Wait for sessions to expire** (controlled by `SESSION_MAX_AGE_DAYS`), then remove the old key from `JWT_PREVIOUS_KEYS`.

### How it works

- New tokens are signed with the current `JWT_SIGNING_KEY`
- Incoming tokens are verified against all keys in `JWT_PREVIOUS_KEYS` if the current key fails
- Sessions reference a server-side row, so revocation still works during rotation

## Password Encryption Key Rotation

Password encryption keys protect credential secrets, TOTP secrets, and notes stored in the vault.

### Steps

1. **Generate a new encryption key:**
   ```bash
   ./scripts/keygen.sh
   ```
   Copy the `PASSWORD_ENCRYPTION_KEY` line from the output.

2. **Update `.env`:**
   ```bash
   # Move the old key to the previous-keys list
   PASSWORD_PREVIOUS_KEYS=<old-kid>:<old-key>
   
   # Set the new key and increment the KID
   PASSWORD_ENCRYPTION_KEY=<new-key>
   PASSWORD_ENCRYPTION_KEY_KID=2026-02   # bump this
   ```

3. **Restart the stack:**
   ```bash
   docker compose up -d
   ```
   
   New passwords are immediately encrypted under the new key. Existing passwords continue to decrypt via `PASSWORD_PREVIOUS_KEYS` and are re-encrypted under the new key on their next update.

4. **Bulk re-encrypt (optional but recommended):**
   To migrate all existing ciphertext blobs to the new key at once:
   ```bash
   docker compose exec api node dist/cli.js reencrypt-passwords
   ```
   
   Add `--force` to re-encrypt even blobs already on the current key (useful after a key format migration).

5. **Remove old keys** from `PASSWORD_PREVIOUS_KEYS` after bulk re-encryption is complete.

### How it works

- Every ciphertext blob is stamped with the `kid` that encrypted it
- On decrypt, the API looks up the correct key by `kid`
- On next update (or bulk re-encrypt), the blob is re-wrapped under the current key

## Postgres and Redis Password Changes

Changing `POSTGRES_PASSWORD` or `REDIS_PASSWORD` requires a coordinated update:

1. Stop the stack: `docker compose down`
2. Update the password in `.env`
3. Update `DATABASE_URL` / `REDIS_URL` to contain the new password
4. Restart: `docker compose up -d`

For Postgres, the actual database role password must also be changed inside Postgres before the restart, or the API will fail to connect:

```bash
docker compose exec postgres psql -U postgres -c \
  "ALTER ROLE weavestream WITH PASSWORD '<new-password>';"
```

## MFA Encryption Key

`MFA_ENCRYPTION_KEY` encrypts TOTP secrets. Rotation requires re-encrypting all TOTP secrets. There is no automated CLI for this yet — contact the project maintainers if you need to rotate this key.

## Rotation Checklist

- [ ] Generate new key
- [ ] Add old key to `*_PREVIOUS_KEYS`
- [ ] Bump the `*_KID` variable
- [ ] `docker compose up -d`
- [ ] Verify the stack is healthy (`docker compose ps`)
- [ ] For passwords: run `reencrypt-passwords` CLI
- [ ] After expiry period: remove old key from `*_PREVIOUS_KEYS`
- [ ] `docker compose up -d` again to load the trimmed key list
