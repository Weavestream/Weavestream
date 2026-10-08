import type {
  CatchAllFamilyGap,
  EgressBlocksResponse,
  IpRule,
  LockoutsResponse,
  LoginActivity,
  SecuritySessionRow,
  ThrottleBlockEntry,
  AdminApiKeyPage,
} from '@weavestream/shared';
import { serverApiFetch } from './core';

// ───────────────────────────────────────────────────────────────────
// Security Center (Phase 12 — read-only first)
//
// All four reads are gated server-side by the `security.read` action,
// which maps to the `SECURITY_READ` platform capability. Session
// revocation lives at `DELETE /security/sessions/:id` and escalates
// to `user.manage`.
// ───────────────────────────────────────────────────────────────────

// WS-024 connection diagnostics — mirrors `ConnectionDiagnostics` in
// `apps/api/src/security/security.service.ts`. Fetched client-side (via
// `apiFetch`, not `serverApiFetch`) so the request travels the real
// browser → proxy → API path being diagnosed; see the Security Center
// client component. No server fetch helper here by design.
export async function getSecurityLoginActivity(
  windowHours = 24,
): Promise<LoginActivity | null> {
  const res = await serverApiFetch<LoginActivity>(
    `/security/login-activity?windowHours=${windowHours}`,
  );
  return res.ok ? res.data : null;
}

export async function getSecurityLockouts(): Promise<LockoutsResponse | null> {
  const res = await serverApiFetch<LockoutsResponse>('/security/lockouts');
  return res.ok ? res.data : null;
}

// Whether the enabled IP rules deny one address family entirely but leave
// the other to default-allow — see `GET /security/ip-rule-coverage` and
// `findCatchAllFamilyGap` in `@weavestream/shared`.
export type IpRuleCoverage = { gap: CatchAllFamilyGap | null };

export async function getSecurityIpRuleCoverage(): Promise<IpRuleCoverage | null> {
  const res = await serverApiFetch<IpRuleCoverage>('/security/ip-rule-coverage');
  return res.ok ? res.data : null;
}

export async function getSecurityThrottleBlocks(): Promise<
  ThrottleBlockEntry[] | null
> {
  const res = await serverApiFetch<ThrottleBlockEntry[]>(
    '/security/throttle-blocks',
  );
  return res.ok ? res.data : null;
}

export async function getSecuritySessions(): Promise<
  SecuritySessionRow[] | null
> {
  const res = await serverApiFetch<{ items: SecuritySessionRow[] }>(
    '/security/sessions?limit=200',
  );
  return res.ok ? (res.data?.items ?? []) : null;
}

/** One page of every unrevoked API key with its owner, or null when the read failed. */
export async function getSecurityApiKeys(
  page: number,
  pageSize: number,
): Promise<AdminApiKeyPage | null> {
  const q = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  const res = await serverApiFetch<AdminApiKeyPage>(`/security/api-keys?${q.toString()}`);
  return res.ok ? res.data : null;
}

export async function getSecurityEgressBlocks(
  windowHours = 168,
): Promise<EgressBlocksResponse | null> {
  const res = await serverApiFetch<EgressBlocksResponse>(
    `/security/egress-blocks?windowHours=${windowHours}`,
  );
  return res.ok ? res.data : null;
}

// ---------------------------------------------------------------------
// Phase 5: IP allow/deny rules (global, enforced before auth)
// ---------------------------------------------------------------------

export async function listIpRules(): Promise<IpRule[]> {
  const res = await serverApiFetch<{ items: IpRule[] }>('/ip-rules');
  return res.data?.items ?? [];
}
