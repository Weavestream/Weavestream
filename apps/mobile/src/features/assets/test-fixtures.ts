import type { IntegrationTargetProvenance, PasswordSummary } from '@weavestream/shared';
import type {
  AssetRecord,
  AssetsPage,
  LayoutFieldRecord,
  LayoutRecord,
} from './api';

/**
 * Full valid wire shapes (not partials) so a schema field added later
 * fails compilation here rather than silently narrowing the tests —
 * same discipline as the passwords/articles fixtures.
 *
 * `makeCredential` re-declares a full `PasswordSummary` locally instead
 * of importing `features/passwords/test-fixtures` — feature isolation
 * applies to tests too.
 */

export const FIXTURE_LAYOUT_ID = 'd0000000-0000-4000-8000-0000000000d1';
export const FIXTURE_COMPANY_ID = 'c0000000-0000-4000-8000-0000000000c1';

export function makeLayoutField(
  over: Partial<LayoutFieldRecord> & { slug: string },
): LayoutFieldRecord {
  return {
    id: `f-${over.slug}`,
    name: over.slug,
    fieldType: 'TEXT',
    position: 0,
    isRequired: false,
    isUniquePerCompany: false,
    visibleToClients: true,
    isPrimary: false,
    showInTable: false,
    options: {},
    archivedAt: null,
    ...over,
  };
}

/**
 * TEXT primary + showInTable IP + non-table RICH_TEXT — the smallest
 * layout that exercises the card projection (primary, extra, excluded).
 */
export function makeLayout(over: Partial<LayoutRecord> = {}): LayoutRecord {
  return {
    id: FIXTURE_LAYOUT_ID,
    name: 'Servers',
    slug: 'servers',
    icon: 'dns',
    color: '#0d7d72',
    isActive: true,
    version: 3,
    position: 0,
    archivedAt: null,
    createdBy: null,
    createdAt: '2026-05-01T09:00:00.000Z',
    updatedAt: '2026-07-01T09:00:00.000Z',
    fields: [
      makeLayoutField({ slug: 'hostname', name: 'Hostname', isPrimary: true, position: 0 }),
      makeLayoutField({
        slug: 'mgmt_ip',
        name: 'Management IP',
        fieldType: 'IP_ADDRESS',
        showInTable: true,
        position: 1,
      }),
      makeLayoutField({
        slug: 'runbook',
        name: 'Runbook',
        fieldType: 'RICH_TEXT',
        position: 2,
      }),
    ],
    ...over,
  };
}

export function makeAsset(over: Partial<AssetRecord> = {}): AssetRecord {
  return {
    id: 'b0000000-0000-4000-8000-0000000000b1',
    companyId: FIXTURE_COMPANY_ID,
    assetLayoutId: FIXTURE_LAYOUT_ID,
    layoutName: 'Servers',
    layoutSlug: 'servers',
    layoutIcon: 'dns',
    layoutColor: '#0d7d72',
    name: 'srv-pines-01',
    externalId: null,
    externalSource: null,
    archivedAt: null,
    createdBy: 'a0000000-0000-4000-8000-0000000000u1',
    updatedBy: 'a0000000-0000-4000-8000-0000000000u1',
    createdByUser: { id: 'a0000000-0000-4000-8000-0000000000u1', name: 'A. Reyes' },
    updatedByUser: { id: 'a0000000-0000-4000-8000-0000000000u1', name: 'A. Reyes' },
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-07-02T14:30:00.000Z',
    lastSyncedAt: null,
    syncedFieldIds: [],
    syncSources: [],
    provenance: [],
    fieldValues: {
      hostname: 'srv-pines-01',
      mgmt_ip: '10.20.0.5',
    },
    fields: [
      { id: 'f-hostname', slug: 'hostname', name: 'Hostname', fieldType: 'TEXT', isPrimary: true, visibleToClients: true, options: {} },
      { id: 'f-mgmt_ip', slug: 'mgmt_ip', name: 'Management IP', fieldType: 'IP_ADDRESS', isPrimary: false, visibleToClients: true, options: {} },
      { id: 'f-runbook', slug: 'runbook', name: 'Runbook', fieldType: 'RICH_TEXT', isPrimary: false, visibleToClients: true, options: {} },
    ],
    references: {},
    isStarred: false,
    ...over,
  };
}

export function makeAssetsPage(
  items: AssetRecord[],
  nextCursor: string | null = null,
): AssetsPage {
  return { items, nextCursor };
}

export function makeProvenance(
  over: Partial<IntegrationTargetProvenance> = {},
): IntegrationTargetProvenance {
  return {
    integrationId: '10000000-0000-4000-8000-0000000000i1',
    integrationName: 'Action1 (HQ)',
    integrationCompanyMappingId: '10000000-0000-4000-8000-0000000000m1',
    resourceId: '10000000-0000-4000-8000-0000000000r1',
    sourceLabel: 'Action1',
    sourceResource: 'action1:endpoints',
    ownership: 'weavestream',
    state: 'active',
    firstSeenAt: '2026-06-01T09:00:00.000Z',
    lastSeenAt: '2026-07-20T09:00:00.000Z',
    lastSyncedAt: '2026-07-20T09:00:00.000Z',
    staleSince: null,
    target: {
      targetKind: 'asset',
      targetId: 'b0000000-0000-4000-8000-0000000000b1',
      targetLabel: 'srv-pines-01',
      targetHref: null,
    },
    ...over,
  };
}

export function makeCredential(over: Partial<PasswordSummary> = {}): PasswordSummary {
  return {
    id: 'e0000000-0000-4000-8000-0000000000e1',
    companyId: FIXTURE_COMPANY_ID,
    folderId: null,
    assetId: 'b0000000-0000-4000-8000-0000000000b1',
    name: 'srv-pines-01 iDRAC',
    username: 'root',
    url: null,
    color: null,
    tags: [],
    hasTotp: false,
    passwordStrength: 4,
    pwnedCount: 0,
    lastRotatedAt: null,
    rotationReminderDays: null,
    expiresAt: null,
    visibleToClients: false,
    requireReasonToView: false,
    restrictedToUserIds: [],
    archivedAt: null,
    createdBy: 'a0000000-0000-4000-8000-0000000000u1',
    updatedBy: 'a0000000-0000-4000-8000-0000000000u1',
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-07-02T14:30:00.000Z',
    ...over,
  };
}
