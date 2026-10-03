import { z } from 'zod';

export const BREEZE_RESOURCE_KEYS = [
  'sites',
  'devices',
  'site-inventory',
  'device-inventory',
  'device-software',
  'network-equipment',
  'virtual-machines',
  'subnets',
  'ip-reservations',
  'configuration-policies',
  'configuration-assignments',
  'configuration-assignment-relations',
  'scripts',
  'automations',
  'automation-relations',
  'backup-configurations',
  'backup-configuration-relations',
  'custom-fields',
  'custom-field-values',
  'device-relationships',
] as const;

export const breezeResourceKeySchema = z.enum(BREEZE_RESOURCE_KEYS);
export type BreezeResourceKey = z.infer<typeof breezeResourceKeySchema>;

export const BREEZE_SOURCE_ENDPOINTS = [
  'organizations',
  'sites',
  'devices',
  'device-inventory',
  'device-software',
  'configuration-policies',
  'configuration-assignments',
  'scripts',
  'automations',
  'backup-configurations',
  'custom-fields',
  'custom-field-values',
  'device-relationships',
] as const;

export const breezeSourceEndpointSchema = z.enum(BREEZE_SOURCE_ENDPOINTS);
export type BreezeSourceEndpoint = z.infer<typeof breezeSourceEndpointSchema>;

export const BREEZE_ENDPOINT_BY_RESOURCE: Readonly<
  Record<BreezeResourceKey, BreezeSourceEndpoint>
> = {
  sites: 'sites',
  devices: 'devices',
  'site-inventory': 'device-inventory',
  'device-inventory': 'device-inventory',
  'device-software': 'device-software',
  'network-equipment': 'device-inventory',
  'virtual-machines': 'device-inventory',
  subnets: 'device-inventory',
  'ip-reservations': 'device-inventory',
  'configuration-policies': 'configuration-policies',
  'configuration-assignments': 'configuration-assignments',
  'configuration-assignment-relations': 'configuration-assignments',
  scripts: 'scripts',
  automations: 'automations',
  'automation-relations': 'automations',
  'backup-configurations': 'backup-configurations',
  'backup-configuration-relations': 'backup-configurations',
  'custom-fields': 'custom-fields',
  'custom-field-values': 'custom-field-values',
  'device-relationships': 'device-relationships',
};


// Breeze may add keys, enum values, and nested data within schemaVersion "1"
// (it bumps the version only for removals, renames, and type changes). These
// schemas are a tolerant reader, not a mirror of the Breeze contract:
//
// - Unknown keys are stripped (Zod's default), so they are never scanned,
//   rendered, or stored, and they never fail a page.
// - Only fields Weavestream reads are declared. Value sets Weavestream only
//   displays (OS, roles, languages, statuses, edge types, ...) are plain text.
// - Breeze's own length limits and internal consistency rules are not
//   repeated here; Weavestream's writers enforce Weavestream's bounds.
// - A field Weavestream reads but Breeze omits becomes null (or an empty
//   list), so an older or newer Breeze still parses.
//
// The record identity (`id`, `orgId`, `sourceUpdatedAt`, `revision`) and the
// envelope stay required: without them a record cannot be scoped or tracked.

const MAX_LIST_ITEMS = 1_000;

const timestamp = z.string().datetime({ offset: true });
const sourceId = z.string().min(1).max(256);
const text = z.string();
const optionalText = z.string().nullish().transform((value) => value ?? null);
const optionalNumber = z.number().finite().nullish().transform((value) => value ?? null);
const optionalBoolean = z.boolean().nullish().transform((value) => value ?? null);
const optionalTextList = z.array(z.string()).nullish().transform((value) => value ?? null);

/**
 * A list Weavestream reads. Over the bound, the record is unreadable rather
 * than truncated: dropped items would vanish silently, and a full traversal
 * could then archive what they had synced.
 */
function list<T extends z.ZodTypeAny>(item: T) {
  return z
    .array(item)
    .max(MAX_LIST_ITEMS)
    .nullish()
    .transform((value): z.output<T>[] => value ?? []);
}

/** A nested object Weavestream reads field by field; omitted means all-null. */
function section<T extends z.ZodRawShape>(shape: T) {
  const schema = z.object(shape);
  return schema.nullish().transform((value) => value ?? schema.parse({}));
}

/** A nested object the transforms already treat as possibly absent. */
function optionalSection<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).nullish().transform((value) => value ?? null);
}

export const breezeRecordBaseSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  siteId: optionalText,
  sourceUpdatedAt: timestamp,
  revision: z.string().min(1).max(256),
});

function record<T extends z.ZodRawShape>(shape: T) {
  return breezeRecordBaseSchema.extend(shape);
}

export const breezeOrganizationSchema = record({
  name: text,
  type: optionalText,
});

export const breezeSiteSchema = record({
  name: text,
  timezone: optionalText,
  address: optionalSection({
    line1: optionalText,
    line2: optionalText,
    city: optionalText,
    region: optionalText,
    postalCode: optionalText,
    country: optionalText,
  }),
  contact: optionalSection({
    name: optionalText,
    email: optionalText,
    phone: optionalText,
  }),
});

export const breezeDeviceSchema = record({
  hostname: text,
  displayName: optionalText,
  type: section({
    os: optionalText,
    role: optionalText,
    virtual: optionalBoolean,
    virtualizationPlatform: optionalText,
  }),
  operatingSystem: section({
    edition: optionalText,
    build: optionalText,
    architecture: optionalText,
  }),
  installation: section({ enrolledAt: optionalText }),
  hardwareIdentity: section({
    serialNumber: optionalText,
    manufacturer: optionalText,
    model: optionalText,
  }),
  stableIdentifiers: section({
    assetTag: optionalText,
    inventoryId: optionalText,
    externalId: optionalText,
  }),
  tags: list(z.string()),
});

const collectionSchema = z
  .object({
    total: optionalNumber,
    included: optionalNumber,
    complete: optionalBoolean,
  })
  .nullish()
  .transform((value) => value ?? null);

const breezeDeviceInventoryRecordSchema = record({
  subjectType: z.literal('device'),
  deviceId: sourceId,
  hardware: section({
    processor: section({ model: optionalText, cores: optionalNumber, threads: optionalNumber }),
    memory: section({ totalMb: optionalNumber }),
    graphics: section({ model: optionalText }),
    motherboard: section({
      manufacturer: optionalText,
      product: optionalText,
      version: optionalText,
    }),
    firmware: section({ biosVersion: optionalText }),
  }),
  disks: list(
    z.object({
      id: sourceId,
      mountPoint: optionalText,
      device: optionalText,
      fileSystem: optionalText,
      totalGb: optionalNumber,
    }),
  ),
  interfaces: list(
    z.object({
      id: sourceId,
      name: optionalText,
      macAddress: optionalText,
      primary: optionalBoolean,
    }),
  ),
  addresses: list(
    z.object({
      id: sourceId,
      interfaceId: optionalText,
      interfaceName: optionalText,
      address: optionalText,
      family: optionalText,
      assignment: optionalText,
      reservationEligible: optionalBoolean,
      subnetMask: optionalText,
      gateway: optionalText,
      dnsServers: list(z.string()),
      active: optionalBoolean,
      firstSeenAt: optionalText,
      deactivatedAt: optionalText,
    }),
  ),
  warranty: optionalSection({
    status: optionalText,
    startsOn: optionalText,
    endsOn: optionalText,
    subscription: optionalBoolean,
  }),
  virtualMachines: list(
    z.object({
      id: sourceId,
      externalId: optionalText,
      name: optionalText,
      generation: optionalNumber,
      memoryMb: optionalNumber,
      processorCount: optionalNumber,
      rctEnabled: optionalBoolean,
      passthroughDisks: optionalBoolean,
    }),
  ),
  collections: section({
    disks: collectionSchema,
    interfaces: collectionSchema,
    addresses: collectionSchema,
    virtualMachines: collectionSchema,
  }),
});

const breezeSiteInventoryRecordSchema = record({
  subjectType: z.literal('site'),
  siteSubjectId: sourceId,
  networkEquipment: list(
    z.object({
      id: sourceId,
      type: optionalText,
      name: optionalText,
      address: optionalText,
      macAddress: optionalText,
      manufacturer: optionalText,
      model: optionalText,
      url: optionalText,
      source: optionalText,
    }),
  ),
  networkSegments: list(z.object({ id: sourceId, cidr: optionalText })),
  collections: section({
    networkEquipment: collectionSchema,
    networkSegments: collectionSchema,
  }),
});

export const breezeDeviceInventorySchema = z.discriminatedUnion('subjectType', [
  breezeDeviceInventoryRecordSchema,
  breezeSiteInventoryRecordSchema,
]);

export const breezeDeviceSoftwareSchema = record({
  deviceId: sourceId,
  software: list(
    z.object({
      id: sourceId,
      name: text,
      version: optionalText,
      vendor: optionalText,
      installedOn: optionalText,
      managed: optionalBoolean,
    }),
  ),
  collection: collectionSchema,
});

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const json: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number().finite(), z.string(), z.array(json), z.record(json),
]));
const optionalJson = json.optional().transform((value) => value ?? null);

export const breezeConfigurationPolicySchema = record({
  sourceScope: optionalText,
  name: text,
  description: optionalText,
  status: optionalText,
  features: list(z.object({
    id: sourceId,
    type: text,
    policyId: optionalText,
    settings: optionalJson,
  })),
});

export const breezeConfigurationAssignmentSchema = record({
  policyId: sourceId,
  policyName: text,
  sourceScope: optionalText,
  level: optionalText,
  targetId: sourceId,
  priority: optionalNumber,
  roleFilter: optionalTextList,
  osFilter: optionalTextList,
});

export const breezeScriptSchema = record({
  sourceScope: optionalText,
  name: text,
  description: optionalText,
  category: optionalText,
  osTypes: list(z.string()),
  language: z.string().nullish().transform((value) => value ?? ''),
  content: z.string().nullish().transform((value) => value ?? ''),
  parameters: optionalJson,
  timeoutSeconds: optionalNumber,
  runAs: optionalText,
  version: optionalNumber,
  exitCodeSeverityMapping: optionalJson,
});

export const breezeAutomationSchema = record({
  sourceScope: optionalText,
  name: text,
  description: optionalText,
  enabled: optionalBoolean,
  trigger: optionalJson,
  conditions: optionalJson,
  actions: list(json),
  onFailure: optionalText,
  notificationTargets: optionalJson,
  // Only script dependencies become relations; other kinds are ignored.
  dependencies: list(z.object({ resource: text, id: sourceId })),
});

const backupCommon = {
  sourceScope: optionalText,
  name: text,
  schedule: optionalJson,
  retention: optionalJson,
  exclusions: list(z.string()),
  restore: optionalJson,
} as const;
const backupDestination = record({
  kind: z.literal('destination'), ...backupCommon,
  type: optionalText, provider: optionalText, compression: optionalBoolean,
  encryption: optionalBoolean, active: optionalBoolean, default: optionalBoolean,
});
const backupProfile = record({
  kind: z.literal('profile'), ...backupCommon, description: optionalText,
  active: optionalBoolean, selections: optionalJson, destinationId: optionalText,
});
const backupPolicy = record({
  kind: z.literal('policy'), ...backupCommon,
  enabled: optionalBoolean, destinationId: optionalText, targets: optionalJson, gfs: optionalJson,
  legalHold: optionalBoolean, legalHoldReason: optionalText,
  bandwidthLimitMbps: optionalNumber,
  backupWindowStart: optionalText, backupWindowEnd: optionalText, priority: optionalNumber,
});
export const breezeBackupConfigurationSchema = z.discriminatedUnion('kind', [
  backupDestination, backupProfile, backupPolicy,
]);

// A missing custom-field type is read as free text, the strictest case for
// the secret inspection in `breeze.transforms.ts`.
const customFieldType = z.string().nullish().transform((value) => value ?? 'text');

export const breezeCustomFieldSchema = record({
  sourceScope: optionalText,
  name: text, fieldKey: text,
  type: customFieldType,
  options: optionalJson, required: optionalBoolean, defaultValue: optionalJson,
  deviceTypes: optionalTextList,
});

export const breezeCustomFieldValueSchema = record({
  deviceId: sourceId,
  definitionId: sourceId,
  name: text,
  fieldKey: text,
  type: customFieldType,
  value: optionalJson,
});

const relationshipEndpointSchema = z.object({ type: text, id: sourceId });

const relationshipEdgesSchema = list(
  z.object({
    key: sourceId,
    type: text,
    from: relationshipEndpointSchema,
    to: relationshipEndpointSchema,
  }),
);

const breezeDeviceRelationshipRecordSchema = record({
  subjectType: z.literal('device'),
  deviceId: sourceId,
  edges: relationshipEdgesSchema,
});

const breezeSiteRelationshipRecordSchema = record({
  subjectType: z.literal('site'),
  siteSubjectId: sourceId,
  edges: relationshipEdgesSchema,
});

export const breezeDeviceRelationshipsSchema = z.discriminatedUnion('subjectType', [
  breezeDeviceRelationshipRecordSchema,
  breezeSiteRelationshipRecordSchema,
]);

export const breezeRecordSchemaByEndpoint: Readonly<Record<BreezeSourceEndpoint, z.ZodTypeAny>> = {
  organizations: breezeOrganizationSchema,
  sites: breezeSiteSchema,
  devices: breezeDeviceSchema,
  'device-inventory': breezeDeviceInventorySchema,
  'device-software': breezeDeviceSoftwareSchema,
  'configuration-policies': breezeConfigurationPolicySchema,
  'configuration-assignments': breezeConfigurationAssignmentSchema,
  scripts: breezeScriptSchema,
  automations: breezeAutomationSchema,
  'backup-configurations': breezeBackupConfigurationSchema,
  'custom-fields': breezeCustomFieldSchema,
  'custom-field-values': breezeCustomFieldValueSchema,
  'device-relationships': breezeDeviceRelationshipsSchema,
};

const VARIANT_KEYS: Partial<Record<BreezeSourceEndpoint, { key: string; values: readonly string[] }>> = {
  'device-inventory': { key: 'subjectType', values: ['device', 'site'] },
  'device-software': { key: 'subjectType', values: ['device'] },
  'device-relationships': { key: 'subjectType', values: ['device', 'site'] },
  'backup-configurations': { key: 'kind', values: ['destination', 'profile', 'policy'] },
};

// What a real variant name looks like (`device`, `cloud_account`).
const VARIANT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/**
 * False only for a well-formed record variant Weavestream does not read (a
 * subject type or backup kind added after this driver was written); such
 * records are skipped. A missing, blank, or malformed discriminator returns
 * true so the schema reports the record as unreadable: skipping it silently
 * would leave a full traversal authoritative and let its data be archived.
 */
export function isSupportedBreezeVariant(endpoint: BreezeSourceEndpoint, raw: unknown): boolean {
  const variant = VARIANT_KEYS[endpoint];
  if (!variant) return true;
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[variant.key] : undefined;
  if (typeof value !== 'string' || !VARIANT_NAME_PATTERN.test(value)) return true;
  return variant.values.includes(value);
}

export type BreezeRecordRead<T> =
  | { success: true; data: T }
  | { success: false; fieldPaths: string[] };

/**
 * Read one record without throwing. Unknown keys are stripped before NULs are
 * removed, so a deeply nested field Weavestream does not read can never trip
 * the sanitize bound. Any failure, including that bound, is reported for this
 * record only, by field path (never by value).
 */
export function readBreezeRecordSafely<T extends z.ZodTypeAny>(
  schema: T,
  raw: unknown,
): BreezeRecordRead<z.output<T>> {
  try {
    const stripped = schema.safeParse(raw);
    const parsed = stripped.success ? schema.safeParse(sanitizeBreezeText(stripped.data)) : stripped;
    if (parsed.success) return { success: true, data: parsed.data };
    const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(record)');
    return { success: false, fieldPaths: [...new Set(paths)].slice(0, 20) };
  } catch {
    // The sanitize depth bound, or nesting too deep for the schema itself.
    return { success: false, fieldPaths: ['(record)'] };
  }
}

const SAFE_FIELD_PATH = /^[A-Za-z0-9_$.[\]-]{1,256}$/u;

export const breezeBlockedRecordSchema = z.object({
  resource: text,
  id: sourceId,
  orgId: z.string().uuid(),
  reason: z.string().transform((value) => value.slice(0, 64)),
  fieldPaths: z
    .array(z.string())
    .nullish()
    .transform((paths) => (paths ?? []).filter((path) => SAFE_FIELD_PATH.test(path)).slice(0, 20)),
});

export type BreezeBlockedRecord = z.infer<typeof breezeBlockedRecordSchema>;
export type BreezeOrganization = z.infer<typeof breezeOrganizationSchema>;
export type BreezeRecordBase = z.infer<typeof breezeRecordBaseSchema>;

/**
 * The page envelope. Records stay unparsed here: each one is read on its own
 * by `transformBreezeRecord`, so one unreadable record cannot fail a page.
 */
export const breezeEnvelopeSchema = z
  .object({
    schemaVersion: z.literal('1'),
    snapshotAt: timestamp,
    data: z.array(z.unknown()).max(500),
    nextCursor: z
      .string()
      .min(1)
      .max(16_384)
      .regex(/^[^\u0000]+$/u)
      .nullish()
      .transform((value) => value ?? null),
    hasMore: z.boolean(),
    blocked: z.array(breezeBlockedRecordSchema).max(500).optional(),
  })
  .refine((value) => !value.hasMore || value.nextCursor !== null, {
    path: ['nextCursor'],
    message: 'nextCursor is required when hasMore is true',
  })
  // A last page carries no cursor onward; the runner requires a terminal page
  // to have none, so a cursor Breeze echoes on it is dropped.
  .transform((value) => (value.hasMore ? value : { ...value, nextCursor: null }));

export interface BreezePartnerEnvelope<T> {
  schemaVersion: '1';
  snapshotAt: string;
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  blocked?: BreezeBlockedRecord[];
}

// Matches the depth bound of the desired-configuration inspection, so nested
// JSON settings that inspection accepts are not rejected here first.
const MAX_SANITIZE_DEPTH = 32;

/** Copy JSON while removing NULs from text. */
export function sanitizeBreezeText(value: unknown): unknown {
  const visit = (input: unknown, depth: number): unknown => {
    if (depth > MAX_SANITIZE_DEPTH) {
      throw new Error('Breeze response exceeds safety bounds.');
    }
    if (typeof input === 'string') return input.replaceAll('\0', '');
    if (Array.isArray(input)) return input.map((entry) => visit(entry, depth + 1));
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([key, entry]) => [
          key,
          visit(entry, depth + 1),
        ]),
      );
    }
    return input;
  };
  return visit(value, 0);
}
