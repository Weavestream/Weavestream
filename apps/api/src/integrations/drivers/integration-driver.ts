import type {
  DriverDescriptor,
  SourceFieldDto,
  SourceOrgDto,
} from '@weavestream/shared';

/**
 * Phase 11 — universal integration driver port.
 *
 * Every external system Weavestream connects to (Action1, NinjaOne in
 * Phase 7, …) is implemented as a class that satisfies this interface.
 * The class is registered in `IntegrationDriverRegistry`; every
 * cross-cutting concern (encryption, persistence, scheduling, RBAC) is
 * driver-agnostic above this layer.
 *
 * Concurrency model:
 *   - `testConnection` / `listSourceOrgs` / `listSourceFields` are
 *     called from the API (controller → service) on a single request.
 *   - `fetchRecords` is called from the worker (per-mapping job). The
 *     driver MUST NOT mutate Weavestream state; it pages through the
 *     external system and yields normalised batches. The framework
 *     handles upserts, audit, sync-record bookkeeping, etc.
 *
 * Error contract:
 *   - Throw `DriverAuthError` if the credentials no longer work — the
 *     orchestrator pauses the integration and surfaces the message.
 *   - Throw `DriverRateLimitError` (with optional `retryAfterMs`) for
 *     429-style rate limits — the worker honours the hint via BullMQ
 *     backoff before retrying.
 *   - Other errors bubble up as a generic driver_error conflict in the
 *     run row; the affected mapping is failed but other mappings keep
 *     processing.
 */

export interface IntegrationContext {
  /** Decoded `Integration.config` (driver-specific JSON). */
  readonly config: Record<string, unknown>;
  /** Decoded credential bundle (driver-specific JSON). */
  readonly secret: Record<string, unknown>;
  /** Defaults pulled from env: timeout, retries, backoff. */
  readonly http: {
    readonly timeoutMs: number;
    readonly maxRetries: number;
    readonly backoffMs: number;
  };
  /** Opaque correlation id stamped on every outbound log line. */
  readonly correlationId: string;
}

export interface FetchRecordsContext extends IntegrationContext {
  /** External org id to scope the fetch to (always set for fan-out drivers). */
  readonly externalOrgId: string;
  /**
   * Resource key the runner is fetching for (e.g. 'devices', 'clients',
   * 'records'). Multi-resource drivers branch on this to hit a different
   * upstream endpoint and shape the records differently. Single-resource
   * drivers can ignore it.
   */
  readonly resourceKey: string;
  /** Mapping-level filter blob (driver-validated). */
  readonly filter: Record<string, unknown>;
}

/**
 * A normalised record produced by the driver — keyed by the driver's
 * own field names. The framework projects this through
 * `IntegrationFieldMapping` rows onto Weavestream `AssetField` slugs.
 */
export interface DriverRecord {
  /** Stable, unique-within-org external id (Action1 endpoint id). */
  externalId: string;
  /** Driver-side display name; used as the asset's primary name fallback. */
  displayName: string | null;
  /** Flat map of source-field key → raw value. */
  fields: Record<string, unknown>;
  /** Optional driver-emitted last-modified hint (UTC ISO). */
  updatedAt: string | null;
}

/**
 * Yielded by `fetchRecords`. Implementations should page large
 * result sets — the worker awaits one page, processes it, and pulls
 * the next. Final page sets `hasMore = false`.
 */
export interface DriverFetchPage {
  records: DriverRecord[];
  hasMore: boolean;
  /** Opaque cursor for the next call. */
  cursor: string | null;
}

export class DriverAuthError extends Error {
  readonly code = 'DriverAuthError' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DriverAuthError';
  }
}

export class DriverRateLimitError extends Error {
  readonly code = 'DriverRateLimitError' as const;
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs = 5_000) {
    super(message);
    this.name = 'DriverRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export interface IntegrationDriver {
  /** Stable id (matches `Integration.driver`). */
  readonly key: string;

  /** Public descriptor used by the admin UI to render dynamic forms. */
  readonly descriptor: DriverDescriptor;

  /**
   * Validate a freshly-submitted (config, secret) pair against the
   * remote API. Returning normally = healthy. Throw on auth failure /
   * unreachable host / wrong tenant.
   */
  testConnection(ctx: IntegrationContext): Promise<{ ok: true; details?: string }>;

  /** List external organisations / tenants the credentials can see. */
  listSourceOrgs(ctx: IntegrationContext): Promise<SourceOrgDto[]>;

  /**
   * List the fields available on records pulled from `externalOrgId`
   * for a specific `resourceKey`. Drivers with a static field catalogue
   * can ignore both params; multi-resource drivers branch on
   * `resourceKey` to return the right field set.
   */
  listSourceFields(
    ctx: IntegrationContext & { externalOrgId: string; resourceKey: string },
  ): Promise<SourceFieldDto[]>;

  /** Walk paginated records for a single org. */
  fetchRecords(
    ctx: FetchRecordsContext,
    cursor: string | null,
  ): Promise<DriverFetchPage>;
}
