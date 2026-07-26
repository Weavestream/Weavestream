import type { PasswordDetail, PasswordSummary } from '@weavestream/shared';

/**
 * Spec-only factories (imported exclusively from `*.spec.ts` /
 * `*.test.tsx`; never from app code). Full valid shapes so a schema
 * field added later fails compilation here instead of drifting.
 */

const UUID = 'a0000000-0000-4000-8000-00000000000';

export function makePasswordSummary(
  over: Partial<PasswordSummary> = {},
): PasswordSummary {
  return {
    id: `${UUID}1`,
    companyId: `${UUID}2`,
    folderId: null,
    assetId: null,
    name: 'Router admin',
    username: 'admin',
    url: null,
    color: null,
    tags: [],
    hasTotp: false,
    passwordStrength: 3,
    pwnedCount: 0,
    lastRotatedAt: null,
    rotationReminderDays: null,
    expiresAt: null,
    visibleToClients: false,
    requireReasonToView: false,
    restrictedToUserIds: [],
    archivedAt: null,
    createdBy: `${UUID}3`,
    updatedBy: `${UUID}3`,
    createdAt: '2026-01-05T10:00:00.000Z',
    updatedAt: '2026-01-06T10:00:00.000Z',
    ...over,
  };
}

export function makePasswordDetail(
  over: Partial<PasswordDetail> = {},
): PasswordDetail {
  return {
    ...makePasswordSummary(),
    notes: null,
    totpAlgorithm: 'SHA1',
    totpDigits: 6,
    totpPeriod: 30,
    ...over,
  };
}
