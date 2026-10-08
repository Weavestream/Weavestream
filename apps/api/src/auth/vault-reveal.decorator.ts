import { SetMetadata } from '@nestjs/common';

export const VAULT_REVEAL_KEY = 'vaultReveal';

/**
 * Marks a route that decrypts stored credentials.
 *
 * API-key principals are denied these by default and admitted only when the
 * key was deliberately minted with `allowPasswordReveal`. The default matters
 * more than the switch: a key leaked from a CI runner or a stray `.env` would
 * otherwise be able to drain the whole vault, which is the worst outcome
 * available in a product that exists to hold client secrets.
 *
 * Interactive sessions are unaffected — they are governed by
 * `@RequirePermission('password.reveal')` and the per-route throttles as before.
 */
export const VaultReveal = () => SetMetadata(VAULT_REVEAL_KEY, true);
