import { hasEligibleNativeBinding } from './native-binding-ownership.js';

const identity = {
  integrationCompanyMappingId: 'mapping-1',
  resourceId: 'resource-1',
  externalId: 'org-1:devices:asset-1',
  integrationId: 'integration-1',
  companyId: 'company-1',
  targetKind: 'asset' as const,
  targetId: 'asset-1',
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    assetId: identity.targetId,
    subnetId: null,
    ipReservationId: null,
    articleId: null,
    relationId: null,
    state: 'active',
    companyMapping: { integrationId: identity.integrationId, externalOrgId: 'org-1' },
    resource: { integrationId: identity.integrationId, resourceKey: 'devices' },
    provenance: {
      integrationId: identity.integrationId,
      externalOrgId: 'org-1',
      resourceKey: 'devices',
      externalId: identity.externalId,
      ownership: 'breeze',
      state: 'active',
    },
    ...overrides,
  };
}

function client(row: Record<string, unknown>) {
  return { integrationSyncRecord: { findUnique: jest.fn().mockResolvedValue(row) } };
}

describe('hasEligibleNativeBinding persisted provenance identity', () => {
  it.each(['active', 'stale'] as const)('accepts complete %s persisted identity', async (state) => {
    const row = record({
      state,
      provenance: { ...record().provenance as object, state },
    });
    await expect(hasEligibleNativeBinding(client(row), identity)).resolves.toBe(true);
  });

  it.each([
    ['external organization', { externalOrgId: 'other-org' }],
    ['resource key', { resourceKey: 'other-resource' }],
    ['external id', { externalId: 'other-external-id' }],
  ])('rejects a provenance %s mismatch', async (_label, provenanceOverride) => {
    const row = record({ provenance: { ...record().provenance as object, ...provenanceOverride } });
    await expect(hasEligibleNativeBinding(client(row), identity)).resolves.toBe(false);
  });
});
