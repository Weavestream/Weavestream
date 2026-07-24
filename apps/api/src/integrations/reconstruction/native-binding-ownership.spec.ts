import {
  hasEligibleNativeBinding,
  hasEligibleNativeSiblingBinding,
  hasEligibleNativeTargetBinding,
} from './native-binding-ownership.js';

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
  it.each(['active', 'stale', 'blocked'] as const)('accepts complete exact %s persisted identity', async (state) => {
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

  it('accepts canonical target ownership only from another complete eligible binding', async () => {
    const row = record({ externalId: 'org-1:devices:asset-2' });
    const targetClient = {
      integrationSyncRecord: {
        findUnique: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(row),
      },
    };

    await expect(
      hasEligibleNativeTargetBinding(targetClient, {
        integrationCompanyMappingId: identity.integrationCompanyMappingId,
        resourceId: identity.resourceId,
        integrationId: identity.integrationId,
        companyId: identity.companyId,
        targetKind: identity.targetKind,
        targetId: identity.targetId,
      }),
    ).resolves.toBe(false);

    const eligibleExternalId = 'org-1:devices:asset-2';
    targetClient.integrationSyncRecord.findFirst.mockResolvedValue(
      record({
        externalId: eligibleExternalId,
        state: 'blocked',
        provenance: {
          ...record().provenance as object,
          externalId: eligibleExternalId,
          state: 'blocked',
        },
      }),
    );
    await expect(
      hasEligibleNativeTargetBinding(targetClient, {
        integrationCompanyMappingId: identity.integrationCompanyMappingId,
        resourceId: identity.resourceId,
        integrationId: identity.integrationId,
        companyId: identity.companyId,
        targetKind: identity.targetKind,
        targetId: identity.targetId,
      }),
    ).resolves.toBe(false);

    targetClient.integrationSyncRecord.findFirst.mockResolvedValue(
      record({
        externalId: eligibleExternalId,
        provenance: {
          ...record().provenance as object,
          externalId: eligibleExternalId,
        },
      }),
    );
    await expect(
      hasEligibleNativeTargetBinding(targetClient, {
        integrationCompanyMappingId: identity.integrationCompanyMappingId,
        resourceId: identity.resourceId,
        integrationId: identity.integrationId,
        companyId: identity.companyId,
        targetKind: identity.targetKind,
        targetId: identity.targetId,
      }),
    ).resolves.toBe(true);
  });

  it('recognizes only complete eligible sibling bindings', async () => {
    const siblingExternalId = 'org-1:devices:asset-2';
    const eligible = record({
      externalId: siblingExternalId,
      provenance: {
        ...record().provenance as object,
        externalId: siblingExternalId,
      },
    });
    const siblingClient = {
      integrationSyncRecord: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          record({
            externalId: 'org-1:devices:forged',
            provenance: { ...record().provenance as object, ownership: 'weavestream' },
          }),
          eligible,
        ]),
      },
    };

    await expect(
      hasEligibleNativeSiblingBinding(siblingClient, identity),
    ).resolves.toBe(true);
    expect(siblingClient.integrationSyncRecord.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalId: { not: identity.externalId },
          assetId: identity.targetId,
        }),
        take: 256,
      }),
    );

    siblingClient.integrationSyncRecord.findMany.mockResolvedValue([
      record({
        externalId: 'org-1:devices:forged',
        provenance: { ...record().provenance as object, ownership: 'weavestream' },
      }),
    ]);
    await expect(
      hasEligibleNativeSiblingBinding(siblingClient, identity),
    ).resolves.toBe(false);
  });
});
