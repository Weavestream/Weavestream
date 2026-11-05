/**
 * Drivers whose record ids are unique only inside one integration: 2
 * integrations of the driver can send the same id for different records,
 * so their assets carry the integration id in the external source.
 */
const INTEGRATION_SCOPED_DRIVERS: ReadonlySet<string> = new Set(['breeze', 'custom-api']);

export function integrationAssetExternalSource(
  driver: string,
  integrationId: string,
): string {
  return INTEGRATION_SCOPED_DRIVERS.has(driver) ? `${driver}:${integrationId}` : driver;
}
