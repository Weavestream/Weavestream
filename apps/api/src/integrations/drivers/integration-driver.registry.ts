import { Injectable, NotFoundException } from '@nestjs/common';
import type { DriverDescriptor } from '@weavestream/shared';
import type { IntegrationDriver } from './integration-driver.js';
import { Action1Driver } from './action1/action1.driver.js';
import { NinjaOneDriver } from './ninjaone/ninjaone.driver.js';
import { UniFiSiteManagerDriver } from './unifi/unifi.driver.js';
import { CloudflareDriver } from './cloudflare/cloudflare.driver.js';
import { CloudflareApiClient } from './cloudflare/cloudflare-api.client.js';

/**
 * Phase 11 — global registry of every available integration driver.
 *
 * Two driver kinds coexist behind one descriptor surface:
 *   - `pull` drivers (Action1, UniFi) implement `IntegrationDriver` and
 *     feed records into the asset-import pipeline.
 *   - `security` drivers (Cloudflare) manage external state where
 *     Weavestream is the source of truth. They do NOT implement
 *     `IntegrationDriver`; their controller surfaces (e.g.
 *     `CloudflareListsController`) call the driver's narrow methods
 *     directly. They live in a parallel `securityDrivers` slot so
 *     `get(key)` never accidentally hands a security driver to the
 *     asset-pull dispatch.
 *
 * Both kinds are listed via `list()` so the admin UI can render the
 * "available integrations" gallery + credential form for either.
 */
@Injectable()
export class IntegrationDriverRegistry {
  private readonly pullByKey: Map<string, IntegrationDriver>;
  private readonly securityByKey: Map<string, CloudflareDriver>;
  private readonly descriptorByKey: Map<string, DriverDescriptor>;

  constructor() {
    const pullDrivers: IntegrationDriver[] = [
      new Action1Driver(),
      new NinjaOneDriver(),
      new UniFiSiteManagerDriver(),
    ];
    const securityDrivers: CloudflareDriver[] = [
      new CloudflareDriver(new CloudflareApiClient()),
    ];

    this.pullByKey = new Map(pullDrivers.map((d) => [d.key, d]));
    this.securityByKey = new Map(securityDrivers.map((d) => [d.key, d]));
    this.descriptorByKey = new Map([
      ...pullDrivers.map(
        (d) => [d.key, d.descriptor] as readonly [string, DriverDescriptor],
      ),
      ...securityDrivers.map(
        (d) => [d.key, d.descriptor] as readonly [string, DriverDescriptor],
      ),
    ]);
  }

  /** Returns every available driver descriptor — both pull and security. */
  list(): DriverDescriptor[] {
    return [...this.descriptorByKey.values()];
  }

  /** Returns the descriptor for any registered driver (pull or security). */
  describe(key: string): DriverDescriptor {
    const d = this.descriptorByKey.get(key);
    if (!d) throw new NotFoundException(`Unknown integration driver: ${key}`);
    return d;
  }

  /** True for any registered driver (pull or security). */
  has(key: string): boolean {
    return this.descriptorByKey.has(key);
  }

  /** Whether this driver participates in the asset-import pipeline. */
  kindOf(key: string): 'pull' | 'security' {
    if (this.pullByKey.has(key)) return 'pull';
    if (this.securityByKey.has(key)) return 'security';
    throw new NotFoundException(`Unknown integration driver: ${key}`);
  }

  /**
   * Resolve an asset-pull driver. Throws 404 if the key isn't a pull
   * driver — security drivers are intentionally rejected here so the
   * orchestrator / sync code paths cannot accidentally dispatch on
   * them.
   */
  get(key: string): IntegrationDriver {
    const d = this.pullByKey.get(key);
    if (!d) {
      if (this.securityByKey.has(key)) {
        throw new NotFoundException(
          `Driver "${key}" is a security driver — asset-import operations are not supported.`,
        );
      }
      throw new NotFoundException(`Unknown integration driver: ${key}`);
    }
    return d;
  }

  /** Resolve a security driver. Throws 404 if the key isn't one. */
  getSecurity(key: string): CloudflareDriver {
    const d = this.securityByKey.get(key);
    if (!d) {
      throw new NotFoundException(
        `Driver "${key}" is not a registered security driver.`,
      );
    }
    return d;
  }
}
