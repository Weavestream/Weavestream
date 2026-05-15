import type {
  DriverDescriptor,
  SourceFieldDto,
  SourceOrgDto,
  TicketDetailDto,
  TicketListFilter,
  TicketListResponse,
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
  /**
   * Stable Weavestream integration id. Optional so existing callers /
   * tests that don't supply it keep working, but drivers that need to
   * key process-wide caches (e.g. NinjaOne's OAuth token cache) read
   * it here. NEVER use this as a tenant scope — the framework already
   * resolves that from `IntegrationCompanyMapping`.
   */
  readonly integrationId?: string;
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

/**
 * Read-only ticket browse context. Drivers implementing the optional
 * `listTickets` / `getTicket` methods receive this on every call.
 *
 * `externalOrgId` is nullable: when null, the call is a GLOBAL admin
 * browse (Phase 12+) — the driver should return every ticket the API
 * client can see and let the service layer resolve each row's upstream
 * client id to a Weavestream company. When set, the driver MUST
 * enforce that every returned row belongs to that single upstream org
 * (IDOR backstop for the legacy per-company surface).
 */
export interface TicketContext extends IntegrationContext {
  readonly externalOrgId: string | null;
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

  /**
   * Phase 12 — optional read-only ticket browse surface. Only
   * implemented by drivers whose descriptor advertises
   * `capabilities.ticketing === true`. The framework dispatches to
   * these via `TicketsService`; never call them directly from sync
   * code paths.
   */
  listTickets?(
    ctx: TicketContext,
    filter: TicketListFilter,
    cursor: string | null,
  ): Promise<TicketListResponse>;

  getTicket?(ctx: TicketContext, ticketId: string): Promise<TicketDetailDto>;
}

/**
 * Type guard for drivers that advertise the optional ticket surface.
 * The dispatcher uses this rather than poking at the descriptor
 * directly so a driver that flips the `ticketing` flag but forgets to
 * implement the methods fails loudly instead of crashing at call time.
 */
export function isTicketingDriver(
  driver: IntegrationDriver,
): driver is IntegrationDriver &
  Required<Pick<IntegrationDriver, 'listTickets' | 'getTicket'>> {
  return (
    driver.descriptor.capabilities.ticketing === true &&
    typeof driver.listTickets === 'function' &&
    typeof driver.getTicket === 'function'
  );
}
