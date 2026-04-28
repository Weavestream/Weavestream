import { Injectable, NotFoundException } from '@nestjs/common';
import type { DriverDescriptor } from '@weavestream/shared';
import type { IntegrationDriver } from './integration-driver.js';
import { Action1Driver } from './action1/action1.driver.js';
import { UniFiSiteManagerDriver } from './unifi/unifi.driver.js';

/**
 * Phase 11 — global registry of every available IntegrationDriver.
 *
 * Driver instances are created at module-construction time (no DI
 * between driver classes — they're tiny stateless adapters) and
 * looked up by `key`. Adding a new driver is a one-line edit here
 * plus the new driver class; no consumer change required.
 *
 * The registry is also the source of truth for the admin UI's
 * "available integrations" picker, exposed via `list()` which
 * returns the safe-to-render `DriverDescriptor` for each driver.
 */
@Injectable()
export class IntegrationDriverRegistry {
  private readonly byKey: Map<string, IntegrationDriver>;

  constructor() {
    const drivers: IntegrationDriver[] = [
      new Action1Driver(),
      new UniFiSiteManagerDriver(),
    ];
    this.byKey = new Map(drivers.map((d) => [d.key, d]));
  }

  /** Returns every available driver descriptor. UI renders the picker from this. */
  list(): DriverDescriptor[] {
    return [...this.byKey.values()].map((d) => d.descriptor);
  }

  /**
   * Resolve by key. Throws 404 if the key is unknown — controller layer
   * surfaces this as a HTTP 404 to the operator (and a user-visible
   * "Driver not installed" hint in the UI).
   */
  get(key: string): IntegrationDriver {
    const d = this.byKey.get(key);
    if (!d) throw new NotFoundException(`Unknown integration driver: ${key}`);
    return d;
  }

  /** Check if a driver is registered without throwing. Used in form validation. */
  has(key: string): boolean {
    return this.byKey.has(key);
  }
}
