import type { AssetSummary } from '@weavestream/shared';

/**
 * Display label for every integration bound to an asset ("Level RMM
 * + NinjaOne"). Several integrations can share one asset,
 * while `externalSource` names only the first (owner) binding.
 */
export function assetSourcesLabel(asset: Pick<AssetSummary, 'syncSources' | 'externalSource'>): string | null {
  const names = Array.from(new Set(asset.syncSources.map((source) => source.integrationName)));
  return names.length > 0 ? names.join(' + ') : asset.externalSource;
}
