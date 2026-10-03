import type { LayoutStats as SharedLayoutStats, LayoutSummary } from '@weavestream/shared';
import type { SameShape, WireJson } from '../common/wire-contract.js';
import type { LayoutStats, SerializedLayout } from './asset-layouts.service.js';

// Type-level contract: the JSON form of the layout serializer types must be
// exactly the shared contracts that the web and mobile clients read. If
// either side changes alone, a `true` literal below stops type-checking.
describe('asset layout wire contract', () => {
  it('serializes SerializedLayout to the shared LayoutSummary', () => {
    const same: SameShape<WireJson<SerializedLayout>, LayoutSummary> = true;
    expect(same).toBe(true);
  });

  it('serializes LayoutStats to the shared LayoutStats', () => {
    const same: SameShape<WireJson<LayoutStats>, SharedLayoutStats> = true;
    expect(same).toBe(true);
  });
});
