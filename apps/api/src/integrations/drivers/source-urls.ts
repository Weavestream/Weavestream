import { action1EndpointUrl } from './action1/action1.sections.js';
import { levelDeviceUrl } from './level/level.sections.js';

/** What a URL builder may use beside the source id: the binding's org and the integration's config. */
type SourceUrlContext = { externalOrgId: string; config: unknown };

/**
 * A synced record's page in its source system, for the "Open in" button on
 * the asset page. Built on read from the binding's external id, so it never
 * passes through (or trips) the stored-section credential scan. A builder
 * returns undefined when it cannot make a safe link.
 */
const SOURCE_URLS: Readonly<Record<string, (sourceId: string, ctx: SourceUrlContext) => string | undefined>> = {
  action1: action1EndpointUrl,
  level: levelDeviceUrl,
};

/**
 * `externalId` is the binding's namespaced id (`<org>:<resource>:<source id>`,
 * see namespacedExternalId); only the source's own id goes into the URL. A
 * binding that does not carry that exact prefix gets no link. `config` is the
 * integration's driver config (never secrets), for drivers whose web app
 * host depends on it.
 */
export function sourceRecordUrl(
  driver: string,
  binding: { externalId: string | null; externalOrgId: string; resourceKey: string; config?: unknown },
): string | undefined {
  const build = Object.hasOwn(SOURCE_URLS, driver) ? SOURCE_URLS[driver] : undefined;
  const prefix = `${binding.externalOrgId}:${binding.resourceKey}:`;
  if (!build || !binding.externalId?.startsWith(prefix)) return undefined;
  const sourceId = binding.externalId.slice(prefix.length);
  return sourceId ? build(sourceId, { externalOrgId: binding.externalOrgId, config: binding.config }) : undefined;
}
