import type { IntegrationDto } from '@weavestream/shared';

/**
 * The integration has what it needs to call its API: a saved secret (or,
 * for OAuth drivers, a connected tenant), or a config that needs none
 * (a Custom API definition with no authentication). The server decides
 * `credentialsRequired`; this only gates buttons and hints. Only an
 * explicit `false` counts, so a DTO without the flag stays gated.
 */
export function credentialsReady(
  integration: Pick<IntegrationDto, 'hasSecret' | 'credentialsRequired'>,
): boolean {
  return integration.hasSecret || integration.credentialsRequired === false;
}
