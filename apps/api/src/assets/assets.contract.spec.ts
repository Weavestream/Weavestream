import type { AssetSummary } from '@weavestream/shared';
import type { SameShape, WireJson } from '../common/wire-contract.js';
import type { SerializedAsset } from './assets.service.js';

// Type-level contract: the JSON form of `SerializedAsset` must be exactly the
// shared `AssetSummary` that the web and mobile clients read. If either side
// changes alone, the `true` literal below stops type-checking.
describe('asset wire contract', () => {
  it('serializes SerializedAsset to the shared AssetSummary', () => {
    const same: SameShape<WireJson<SerializedAsset>, AssetSummary> = true;
    expect(same).toBe(true);
  });
});
