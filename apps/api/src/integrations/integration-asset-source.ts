export function integrationAssetExternalSource(
  driver: string,
  integrationId: string,
): string {
  return driver === 'breeze' ? `breeze:${integrationId}` : driver;
}
