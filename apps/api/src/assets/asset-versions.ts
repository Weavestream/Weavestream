import { ConflictException } from '@nestjs/common';
import type { AssetField, Prisma, UserRole } from '@prisma/client';
import { isUniqueConstraintError } from '../prisma/prisma-errors.js';

/**
 * Asset version history (migration 0098).
 *
 * A version row is the FULL state of an asset after one change. This
 * module owns: building a snapshot from stored rows, diffing two
 * snapshots, appending a version inside the caller's transaction, and
 * projecting a stored row down to what one actor may read.
 *
 * Secret handling: asset field values are stored as plaintext JSON in
 * `asset_field_values` today (accepted risk WS-004) and there is no
 * encrypted/secret asset field type. A snapshot therefore carries exactly
 * the values the live rows carry, with the same protections: tenant
 * scoping on every query, no list-endpoint exposure, and
 * hidden-from-client fields removed on read for CLIENT_USER
 * (`projectVersionForActor`). If an encrypted asset field type is ever
 * added, `buildAssetSnapshot` is the single place that must keep its
 * ciphertext (not plaintext) and `projectVersionForActor` must mask it.
 */

/** Identity columns recorded in `changedFields` as literal tokens. */
type IdentityToken = 'name' | 'externalId' | 'externalSource';

export interface AssetSnapshot {
  name: string;
  externalId: string | null;
  externalSource: string | null;
  /** Keyed by AssetField.id; fields with no value are absent. */
  fieldValues: Record<string, unknown>;
}

export interface PreviousAssetState extends AssetSnapshot {
  /** When the prior state was last written; stamps a baseline row. */
  updatedAt: Date;
}

/** Most versions kept per asset; older ones (never the first or latest) are pruned. */
export const ASSET_VERSION_CAP = 500;

/**
 * Stored `changeReason` for a restore. Deliberately generic: it never
 * carries field names (they can be hidden-from-client fields); the UI
 * renders the details from `changedFields` at read time.
 */
export function restoreChangeReason(fromVersion: number, fieldRestore: boolean): string {
  return fieldRestore ? `restore from v${fromVersion} (field restore)` : `restore from v${fromVersion}`;
}

export const INITIAL_VERSION_REASON = 'initial version';
export const BASELINE_VERSION_REASON = 'Baseline: state before version history began';

export function buildAssetSnapshot(
  asset: { name: string; externalId: string | null; externalSource: string | null },
  rows: ReadonlyArray<{ assetFieldId: string; value: unknown }>,
): AssetSnapshot {
  const fieldValues: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.value === null || row.value === undefined) continue;
    fieldValues[row.assetFieldId] = row.value;
  }
  return {
    name: asset.name,
    externalId: asset.externalId,
    externalSource: asset.externalSource,
    fieldValues,
  };
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

/** JSON with object keys sorted, so key order never reads as a change. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Normalised equality used for version diffs and restore no-op checks. */
export function sameAssetValue(a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  return stableStringify(a) === stableStringify(b);
}

/**
 * Identity tokens and field ids whose normalised value differs. Order is
 * deterministic: name, externalId, externalSource, then field ids sorted.
 */
export function diffAssetSnapshots(prev: AssetSnapshot, next: AssetSnapshot): string[] {
  const changed: string[] = [];
  const tokens: IdentityToken[] = ['name', 'externalId', 'externalSource'];
  for (const token of tokens) {
    if (prev[token] !== next[token]) changed.push(token);
  }
  const ids = new Set([...Object.keys(prev.fieldValues), ...Object.keys(next.fieldValues)]);
  for (const id of [...ids].sort()) {
    if (!sameAssetValue(prev.fieldValues[id], next.fieldValues[id])) changed.push(id);
  }
  return changed;
}

type VersionTx = Pick<
  Prisma.TransactionClient,
  'asset' | 'assetFieldValue' | 'assetVersion' | '$queryRaw'
>;

/**
 * Lock the asset row for the rest of the transaction, then read its state.
 * Taking the "previous state" for a diff here (not before the transaction)
 * means two concurrent editors serialise: the second one diffs against what
 * the first committed, so no stale baseline or lost change is recorded.
 * Returns null when the asset does not exist in `companyId`.
 */
export async function lockAndSnapshotAsset(
  tx: VersionTx,
  companyId: string,
  assetId: string,
): Promise<PreviousAssetState | null> {
  await tx.$queryRaw`SELECT id FROM assets WHERE id = ${assetId}::uuid AND company_id = ${companyId}::uuid FOR UPDATE`;
  const asset = await tx.asset.findFirst({
    where: { id: assetId, companyId },
    select: { name: true, externalId: true, externalSource: true, updatedAt: true },
  });
  if (!asset) return null;
  const rows = await tx.assetFieldValue.findMany({
    where: { assetId, companyId },
    select: { assetFieldId: true, value: true },
  });
  return { ...buildAssetSnapshot(asset, rows), updatedAt: asset.updatedAt };
}

export interface RecordAssetVersionArgs {
  companyId: string;
  assetId: string;
  /** State before the write; `null` for a create (version 1). */
  previous: PreviousAssetState | null;
  /** `null` for integration/system writes. */
  changedBy: string | null;
  changeReason?: string | null;
}

/**
 * Append a version for the asset's CURRENT state (read back inside `tx`,
 * so it is exactly what was persisted, post-canonicalisation). Call after
 * the field values are written, in the same transaction.
 *
 * - create (`previous === null`): version 1, "initial version".
 * - update: a row only when the normalised state differs from `previous`.
 *   An asset with no history yet (edited for the first time after this
 *   feature shipped) first gets its prior state recorded as a baseline
 *   version, so the pre-edit values are not lost.
 * Returns `null` when nothing changed.
 */
export async function recordAssetVersion(
  tx: VersionTx,
  args: RecordAssetVersionArgs,
): Promise<{ version: number; changedFields: string[] } | null> {
  const { companyId, assetId, previous, changedBy } = args;
  const asset = await tx.asset.findFirst({
    where: { id: assetId, companyId },
    select: { name: true, externalId: true, externalSource: true },
  });
  if (!asset) return null;
  const rows = await tx.assetFieldValue.findMany({
    where: { assetId, companyId },
    select: { assetFieldId: true, value: true },
  });
  const next = buildAssetSnapshot(asset, rows);

  let changedFields: string[];
  let reason: string | null;
  if (previous === null) {
    changedFields = [
      'name',
      ...(next.externalId !== null ? ['externalId'] : []),
      ...(next.externalSource !== null ? ['externalSource'] : []),
      ...Object.keys(next.fieldValues).sort(),
    ];
    reason = args.changeReason ?? INITIAL_VERSION_REASON;
  } else {
    changedFields = diffAssetSnapshots(previous, next);
    if (changedFields.length === 0) return null;
    reason = args.changeReason ?? null;
  }

  const latest = await tx.assetVersion.aggregate({
    where: { assetId, companyId },
    _max: { version: true },
  });
  let max = latest._max.version ?? 0;
  if (previous !== null && max === 0) {
    await tx.assetVersion.createMany({
      data: [
        {
          assetId,
          companyId,
          version: 1,
          name: previous.name,
          externalId: previous.externalId,
          externalSource: previous.externalSource,
          fieldValues: previous.fieldValues as Prisma.InputJsonValue,
          changedFields: [],
          changedBy: null,
          changeReason: BASELINE_VERSION_REASON,
          createdAt: previous.updatedAt,
        },
      ],
      skipDuplicates: true,
    });
    const reread = await tx.assetVersion.aggregate({
      where: { assetId, companyId },
      _max: { version: true },
    });
    max = reread._max.version ?? 1;
  }

  const version = max + 1;
  try {
    await tx.assetVersion.create({
      data: {
        assetId,
        companyId,
        version,
        name: next.name,
        externalId: next.externalId,
        externalSource: next.externalSource,
        fieldValues: next.fieldValues as Prisma.InputJsonValue,
        changedFields,
        changedBy,
        changeReason: reason,
      },
    });
  } catch (error) {
    // (assetId, version) is unique: a concurrent editor took this number.
    // Throwing rolls the whole edit back; the caller can retry cleanly.
    if (isUniqueConstraintError(error)) {
      throw new ConflictException(
        'This asset was changed by someone else at the same time. Reload and try again.',
      );
    }
    throw error;
  }
  await enforceVersionCap(tx, companyId, assetId);
  return { version, changedFields };
}

/**
 * Keep at most `ASSET_VERSION_CAP` versions: drop the oldest beyond the
 * cap, never the first (origin/baseline) and never the latest.
 */
export async function enforceVersionCap(
  tx: Pick<Prisma.TransactionClient, 'assetVersion'>,
  companyId: string,
  assetId: string,
  cap = ASSET_VERSION_CAP,
): Promise<number> {
  const total = await tx.assetVersion.count({ where: { assetId, companyId } });
  if (total <= cap) return 0;
  const doomed = await tx.assetVersion.findMany({
    where: { assetId, companyId },
    select: { version: true },
    orderBy: { version: 'asc' },
    skip: 1, // keep the first (origin/baseline)
    take: total - cap,
  });
  if (doomed.length === 0) return 0;
  const res = await tx.assetVersion.deleteMany({
    where: { assetId, companyId, version: { in: doomed.map((d) => d.version) } },
  });
  return res.count;
}

type ProjectableField = Pick<
  AssetField,
  'id' | 'name' | 'fieldType' | 'visibleToClients' | 'archivedAt'
>;

export interface StoredAssetVersion {
  version: number;
  name: string;
  externalId: string | null;
  externalSource: string | null;
  fieldValues: unknown;
  changedFields: string[];
  changedBy: string | null;
  changeReason: string | null;
  redactedAt: Date | null;
  redactedFields: string[];
  createdAt: Date;
}

/** The columns a list row needs (no captured values). */
export type StoredAssetVersionSummary = Pick<
  StoredAssetVersion,
  | 'version'
  | 'changedFields'
  | 'changedBy'
  | 'changeReason'
  | 'redactedAt'
  | 'redactedFields'
  | 'createdAt'
>;

/** Non-archived fields this role may read (same rule as the asset detail). */
export function readableFieldsFor<T extends ProjectableField>(
  fields: readonly T[],
  role: UserRole,
): T[] {
  return fields.filter(
    (f) => f.archivedAt === null && (role !== 'CLIENT_USER' || f.visibleToClients),
  );
}

/**
 * Client readers only ever see the generic form of a restore reason;
 * every other reason (initial/baseline/integration text) becomes null.
 */
export function reasonForClient(reason: string | null): string | null {
  const m = reason?.match(/^restore from v(\d+)/);
  return m ? `restore from v${m[1]}` : null;
}

const IDENTITY_TOKENS = new Set<string>(['name', 'externalId', 'externalSource']);

/**
 * List row for `role`: `changedFields` is filtered to readable fields so a
 * client user cannot learn a hidden field exists or changed, and a client
 * never learns who made a change or why (beyond `restore from vN`).
 */
export function projectVersionSummary(
  row: StoredAssetVersionSummary,
  fields: readonly ProjectableField[],
  role: UserRole,
  nameByUserId: ReadonlyMap<string, string>,
) {
  const client = role === 'CLIENT_USER';
  const readable = new Set(readableFieldsFor(fields, role).map((f) => f.id));
  const redactedReadable = row.redactedFields.some((id) => readable.has(id));
  return {
    version: row.version,
    changedFields: row.changedFields.filter((c) => IDENTITY_TOKENS.has(c) || readable.has(c)),
    changedBy: client ? null : row.changedBy,
    changedByName: client || !row.changedBy ? null : (nameByUserId.get(row.changedBy) ?? null),
    changeReason: client ? reasonForClient(row.changeReason) : row.changeReason,
    createdAt: row.createdAt,
    // A row-level scrub (no per-field list) or a scrub of a readable field.
    redacted:
      row.redactedAt !== null && (row.redactedFields.length === 0 ? true : !client || redactedReadable),
  };
}

/** Captured name, readable values and readable redacted-field ids of one version. */
export function projectVersionState(
  row: Pick<StoredAssetVersion, 'name' | 'fieldValues' | 'redactedFields'>,
  fields: readonly ProjectableField[],
  role: UserRole,
) {
  const readable = new Set(readableFieldsFor(fields, role).map((f) => f.id));
  const stored =
    row.fieldValues && typeof row.fieldValues === 'object' && !Array.isArray(row.fieldValues)
      ? (row.fieldValues as Record<string, unknown>)
      : {};
  const values: Record<string, unknown> = {};
  for (const [fieldId, value] of Object.entries(stored)) {
    if (readable.has(fieldId)) values[fieldId] = value;
  }
  return {
    name: row.name,
    values,
    redactedFields: row.redactedFields.filter((id) => readable.has(id)),
  };
}

/** Full detail of one version plus the state of the previous one. */
export function projectVersionDetail(
  row: StoredAssetVersion,
  previous: StoredAssetVersion | null,
  fields: readonly ProjectableField[],
  role: UserRole,
  nameByUserId: ReadonlyMap<string, string>,
) {
  return {
    ...projectVersionSummary(row, fields, role, nameByUserId),
    externalId: row.externalId,
    externalSource: row.externalSource,
    ...projectVersionState(row, fields, role),
    previous: previous ? projectVersionState(previous, fields, role) : null,
  };
}
