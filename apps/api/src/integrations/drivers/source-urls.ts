import { levelDeviceUrl } from './level/level.sections.js';

/**
 * A synced record's page in its source system, for the "Open in" button on
 * the asset page. Built on read from the binding's external id, so it never
 * passes through (or trips) the stored-section credential scan.
 */
const SOURCE_URLS: Readonly<Record<string, (externalId: string) => string>> = {
  level: levelDeviceUrl,
};

/**
 * `externalId` is the binding's namespaced id (`<org>:<resource>:<source id>`,
 * see namespacedExternalId); only the source's own id goes into the URL. A
 * binding that does not carry that exact prefix gets no link.
 */
export function sourceRecordUrl(
  driver: string,
  binding: { externalId: string | null; externalOrgId: string; resourceKey: string },
): string | undefined {
  const build = Object.hasOwn(SOURCE_URLS, driver) ? SOURCE_URLS[driver] : undefined;
  const prefix = `${binding.externalOrgId}:${binding.resourceKey}:`;
  if (!build || !binding.externalId?.startsWith(prefix)) return undefined;
  const sourceId = binding.externalId.slice(prefix.length);
  return sourceId ? build(sourceId) : undefined;
}
