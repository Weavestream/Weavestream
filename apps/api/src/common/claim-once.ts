import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';

/**
 * Best-effort "first caller in the window wins" gate used to coalesce
 * security-alert audit events at rejection points (IP-rule denials,
 * throttler rejections). Those paths fire on hostile traffic shapes —
 * a blocked client hammering at request rate — so the audit write must
 * be gated to one row per subject per window, and the gate itself must
 * never throw into the rejection path.
 *
 * `SET key '1' EX ttl NX` (same pattern as the upload body-claim in
 * uploads.service.ts). Returns true only when this call claimed the
 * window. On Redis failure it returns false — the alert email is the
 * thing we're prepared to lose, not the 403/429 — but warns (at most
 * once a minute across all keys) so an operator can see the alerting
 * substrate is degraded rather than silently dark (§6: no silent
 * swallow).
 */
const logger = new Logger('SecurityAlertGate');
const WARN_INTERVAL_MS = 60_000;
let lastWarnAt = 0;

export async function claimOnce(
  client: Redis,
  key: string,
  ttlSec: number,
): Promise<boolean> {
  const boundedTtl = Math.max(1, Math.floor(ttlSec));
  try {
    const claimed = await client.set(key, '1', 'EX', boundedTtl, 'NX');
    return claimed === 'OK';
  } catch (err) {
    const now = Date.now();
    if (now - lastWarnAt >= WARN_INTERVAL_MS) {
      lastWarnAt = now;
      logger.warn(
        `claimOnce failed for ${key} — security alert coalescing degraded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return false;
  }
}
