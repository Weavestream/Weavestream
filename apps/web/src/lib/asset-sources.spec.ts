import { assetSourcesLabel } from './asset-sources';

const source = (integrationName: string, driver: string) => ({
  integrationId: '00000000-0000-4000-8000-000000000001', integrationName, driver,
  resourceKey: 'users', lastSyncedAt: '2026-10-01T00:00:00.000Z',
});

describe('assetSourcesLabel', () => {
  it('names every integration bound to a co-bound asset, not only the owner', () => {
    expect(assetSourcesLabel({
      externalSource: 'google-workspace',
      syncSources: [source('Example Google', 'google-workspace'), source('Example Microsoft', 'microsoft-365')],
    })).toBe('Example Google + Example Microsoft');
  });

  it('falls back to the external source, and to null for a manual asset', () => {
    expect(assetSourcesLabel({ externalSource: 'level', syncSources: [] })).toBe('level');
    expect(assetSourcesLabel({ externalSource: null, syncSources: [] })).toBeNull();
  });
});
