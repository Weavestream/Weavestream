import type { TenantContext } from '@weavestream/shared';

/**
 * Models whose rows belong to a single Company. Every query against one of
 * these models must include a `companyId` filter, and that filter must be a
 * subset of the caller's `allowedCompanyIds`. Enforced by PrismaService's
 * tenant middleware.
 *
 * Update this list whenever a new tenant-scoped model is added (Phase 3+
 * Asset, AssetFieldValue, Article, Folder, Upload, Relation, MonitoredDomain,
 * DomainCheck, etc.). The middleware test suite will catch any scoped model
 * that isn't listed here.
 */
export const TENANT_SCOPED_MODELS = new Set<string>([
  // Phase 3: the asset data plane is per-company.
  'Asset',
  'AssetFieldValue',
  'Relation',
  // Phase 4: the documentation plane. All three carry a required
  // (non-null) companyId — see DECISIONS.md D-010 for why there is no
  // "global" escape hatch and no nullable companyId here. "Internal"
  // MSP docs live in a regular Company tenant like any other client.
  // `ArticleVersion` denormalises the parent article's companyId so
  // the middleware can scope it without traversing a relation, same
  // pattern as `PasswordVersion` / `AssetFieldValue`.
  'Article',
  'ArticleVersion',
  'Folder',
  'Upload',
  // Phase 8: domain & SSL monitor. Both rows carry a required
  // (non-null) companyId — a check history row never floats free of
  // its parent monitored_domain's tenant.
  'MonitoredDomain',
  'DomainCheck',
  // Phase 10: password vault. `Password` and `PasswordFolder` have
  // direct `companyId` columns. `PasswordVersion` denormalises the
  // parent's companyId so the tenant middleware can enforce scope
  // without traversing a relation (same pattern as AssetFieldValue).
  'Password',
  'PasswordVersion',
  'PasswordFolder',
  // Phase 11: integration framework. The top-level `Integration`,
  // `IntegrationSecret`, and `IntegrationSyncRun` rows are GLOBAL
  // (no companyId) and are SUPER_ADMIN-gated at the HTTP layer; they
  // are intentionally NOT listed here so the middleware leaves them
  // alone. The four rows below DO carry `companyId` and fan out per-
  // tenant. `IntegrationFieldMapping` itself has no direct companyId
  // — it is reached only through `IntegrationCompanyMapping` and is
  // therefore not listed (the parent mapping enforces scope on read
  // and the middleware-bypassing service-layer transactions are the
  // only place rows are written).
  'IntegrationCompanyMapping',
  'IntegrationSyncRunCompanyResult',
  'IntegrationSyncRecord',
  'IntegrationSyncCheckpoint',
  'IntegrationReconstructionSummary',
  'IntegrationReconstructionGap',
  // IPAM: company-scoped subnet registry and manual IP reservations.
  'Subnet',
  'IpReservation',
  // Phase 1: AuditLog can be cross-tenant (`companyId` is nullable for
  // system events), so it is excluded by design.
  //
  // Phase 3 carve-out: AssetLayout and AssetField are GLOBAL, not
  // tenant-scoped — every company shares the exact same catalog (see
  // DECISIONS.md D-007 layouts-are-global). Access control for layouts
  // is done exclusively at the HTTP layer via
  // `@RequirePermission('layout.manage.global')` for mutations; reads
  // are allowed for any authenticated user so operators and clients
  // alike can render forms and lists.
  //
  // Tags follow the same rule: `Tag` is global so the same identity is
  // reusable across companies and layouts. Inline creation is allowed
  // for any authed user (the asset-write tx upserts unknown names
  // through `TagsService.upsertByName`); rename/delete is gated by
  // `tag.manage.global` (TAG_MANAGE / SUPER_ADMIN). It is intentionally
  // NOT listed here so the middleware leaves it alone.
]);

/** Actions that count as writes. */
export const WRITE_ACTIONS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

export class TenantScopeViolationError extends Error {
  constructor(
    public readonly model: string,
    public readonly action: string,
    public readonly reason: string,
  ) {
    super(`Tenant scope violation on ${model}.${action}: ${reason}`);
    this.name = 'TenantScopeViolationError';
  }
}

/**
 * Pure function — easy to unit-test with any TenantContext and any
 * {model, action, args}. Used by PrismaService middleware.
 */
export function assertTenantScope(
  params: { model: string; action: string; args: Record<string, unknown> },
  ctx: TenantContext,
  scopedModels: Set<string> = TENANT_SCOPED_MODELS,
): void {
  if (!scopedModels.has(params.model)) return;

  const isWrite = WRITE_ACTIONS.has(params.action);
  const where = (params.args['where'] ?? {}) as Record<string, unknown>;
  // `createMany` carries `data` as an array of rows; every row must be
  // scoped on its own. Single-payload actions normalise to a one-row
  // array so both shapes share the extraction below.
  const dataRows: Array<Record<string, unknown>> = Array.isArray(params.args['data'])
    ? (params.args['data'] as Array<Record<string, unknown>>)
    : [(params.args['data'] ?? {}) as Record<string, unknown>];
  // `upsert` splits its payload into `create` / `update` instead of a
  // single `data` object; either side carrying a valid companyId is
  // sufficient to scope the row.
  const create = (params.args['create'] ?? {}) as Record<string, unknown>;
  const update = (params.args['update'] ?? {}) as Record<string, unknown>;

  // SUPER_ADMIN, and operators with a non-NONE `globalAccess`, bypass
  // tenant scoping on reads — `READONLY` only widens reads, `FULL` also
  // widens writes (matching the per-permission rules in
  // `rbac/permissions.ts`). `NONE` keeps the caller pinned to their
  // explicit memberships.
  const hasReadBypass =
    ctx.isSuperAdmin ||
    ctx.globalAccess === 'FULL' ||
    ctx.globalAccess === 'READONLY';
  const hasWriteBypass = ctx.isSuperAdmin || ctx.globalAccess === 'FULL';

  if (hasReadBypass && !isWrite) return;

  const scopeFromWhere = extractCompanyIds(where['companyId']);
  const scopeFromData = isWrite
    ? [
        ...dataRows.flatMap((row) => extractCompanyIds(row['companyId'])),
        ...extractCompanyIds(create['companyId']),
        ...extractCompanyIds(update['companyId']),
      ]
    : [];
  const candidates = isWrite ? scopeFromData.concat(scopeFromWhere) : scopeFromWhere;

  // A createMany call has no `where` to fall back on, so a single row
  // without a companyId fails the whole call (closed) — one in-scope
  // sibling must not vouch for a row the middleware cannot see.
  if (
    isWrite &&
    Array.isArray(params.args['data']) &&
    dataRows.some((row) => extractCompanyIds(row['companyId']).length === 0)
  ) {
    throw new TenantScopeViolationError(
      params.model,
      params.action,
      'a createMany row is missing companyId',
    );
  }

  if (candidates.length === 0) {
    throw new TenantScopeViolationError(
      params.model,
      params.action,
      'no companyId filter was supplied',
    );
  }

  if (!hasWriteBypass) {
    const allowed = new Set(ctx.allowedCompanyIds);
    const outOfScope = candidates.filter((id) => !allowed.has(id));
    if (outOfScope.length > 0) {
      throw new TenantScopeViolationError(
        params.model,
        params.action,
        `companyId(s) not in caller scope: ${outOfScope.join(', ')}`,
      );
    }
  }
}

function extractCompanyIds(node: unknown): string[] {
  if (typeof node === 'string') return [node];
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (typeof obj['equals'] === 'string') return [obj['equals'] as string];
    if (Array.isArray(obj['in'])) {
      return (obj['in'] as unknown[]).filter((v): v is string => typeof v === 'string');
    }
  }
  return [];
}
