import { z } from 'zod';

export const BREEZE_RESOURCE_KEYS = [
  'sites',
  'devices',
  'device-inventory',
  'device-software',
  'subnets',
  'ip-reservations',
  'configuration-policies',
  'scripts',
  'automations',
  'backup-configurations',
  'custom-fields',
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
  'scripts',
  'automations',
  'backup-configurations',
  'custom-fields',
  'device-relationships',
] as const;

export const breezeSourceEndpointSchema = z.enum(BREEZE_SOURCE_ENDPOINTS);
export type BreezeSourceEndpoint = z.infer<typeof breezeSourceEndpointSchema>;

const breezeBlockedResourceSchema = z.enum([
  ...BREEZE_SOURCE_ENDPOINTS,
  'configuration-assignments',
]);

export const BREEZE_ENDPOINT_BY_RESOURCE: Readonly<
  Record<BreezeResourceKey, BreezeSourceEndpoint>
> = {
  sites: 'sites',
  devices: 'devices',
  'device-inventory': 'device-inventory',
  'device-software': 'device-software',
  subnets: 'device-inventory',
  'ip-reservations': 'device-inventory',
  'configuration-policies': 'configuration-policies',
  scripts: 'scripts',
  automations: 'automations',
  'backup-configurations': 'backup-configurations',
  'custom-fields': 'custom-fields',
  'device-relationships': 'device-relationships',
};

const timestamp = z.string().datetime({ offset: true });
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const nullableText = (max = 1_000) => z.string().max(max).nullable();
const requiredText = (max = 1_000) => z.string().min(1).max(max);

export const breezeRecordBaseSchema = z
  .object({
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    siteId: z.string().uuid().nullable(),
    sourceUpdatedAt: timestamp,
    revision,
  })
  .strict();

function record<T extends z.ZodRawShape>(shape: T) {
  return breezeRecordBaseSchema.extend(shape).strict();
}

export const breezeOrganizationSchema = record({
  name: requiredText(255),
  slug: requiredText(100),
  type: z.enum(['customer', 'internal']),
});

export const breezeSiteSchema = record({
  name: requiredText(255),
  timezone: requiredText(64),
  address: z
    .object({
      line1: nullableText(),
      line2: nullableText(),
      city: nullableText(),
      region: nullableText(),
      postalCode: nullableText(),
      country: nullableText(),
    })
    .strict()
    .nullable(),
  contact: z
    .object({
      name: nullableText(),
      email: nullableText(),
      phone: nullableText(),
    })
    .strict()
    .nullable(),
});

export const breezeDeviceSchema = record({
  hostname: requiredText(255),
  displayName: nullableText(255),
  type: z
    .object({
      os: z.enum(['windows', 'macos', 'linux']),
      role: requiredText(30),
      virtual: z.boolean(),
      virtualizationPlatform: nullableText(30),
    })
    .strict(),
  operatingSystem: z
    .object({
      edition: requiredText(100),
      build: nullableText(100),
      architecture: requiredText(20),
    })
    .strict(),
  installation: z.object({ enrolledAt: timestamp }).strict(),
  hardwareIdentity: z
    .object({
      serialNumber: nullableText(100),
      manufacturer: nullableText(255),
      model: nullableText(255),
    })
    .strict(),
  stableIdentifiers: z
    .object({
      assetTag: nullableText(255),
      inventoryId: nullableText(255),
      externalId: nullableText(255),
    })
    .strict(),
  tags: z.array(requiredText(255)).max(200),
  groupIds: z.array(z.string().uuid()).max(500),
  groupMembership: z
    .object({
      total: z.number().int().nonnegative(),
      included: z.number().int().min(0).max(500),
      complete: z.boolean(),
      reason: z.literal('membership_limit_exceeded').nullable(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.included > value.total) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['included'],
          message: 'included cannot exceed total',
        });
      }
      if (value.complete !== (value.included === value.total)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['complete'],
          message: 'complete must reflect membership bounds',
        });
      }
      if ((value.reason === null) !== value.complete) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'reason must reflect completeness',
        });
      }
    }),
  linkGroupId: z.string().uuid().nullable(),
  linkGroupRole: nullableText(16),
});

const namedVersionSchema = z
  .object({
    name: requiredText(255),
    version: nullableText(100),
  })
  .strict();

const interfaceSchema = z
  .object({
    name: requiredText(255),
    macAddress: nullableText(32),
    addresses: z.array(requiredText(64)).max(100),
  })
  .strict();

const subnetSchema = z
  .object({
    id: requiredText(128),
    name: requiredText(200),
    cidr: requiredText(64),
    vlanId: z.number().int().min(1).max(4094).nullable(),
    gateway: nullableText(64),
    dhcpRangeStart: nullableText(64),
    dhcpRangeEnd: nullableText(64),
    description: nullableText(2_000),
  })
  .strict();

const reservationSchema = z
  .object({
    id: requiredText(128),
    subnetId: requiredText(128),
    ipAddress: requiredText(64),
    label: requiredText(200),
    notes: nullableText(2_000),
  })
  .strict();

export const breezeDeviceInventorySchema = record({
  deviceId: z.string().uuid(),
  cpu: z.array(namedVersionSchema).max(64),
  memoryBytes: z.number().int().nonnegative().nullable(),
  firmware: z.array(namedVersionSchema).max(128),
  disks: z
    .array(
      z
        .object({
          name: requiredText(255),
          model: nullableText(255),
          serialNumber: nullableText(100),
          sizeBytes: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    )
    .max(128),
  interfaces: z.array(interfaceSchema).max(256),
  subnets: z.array(subnetSchema).max(256),
  reservations: z.array(reservationSchema).max(500),
  warrantyExpiry: timestamp.nullable(),
  supportExpiry: timestamp.nullable(),
});

export const breezeDeviceSoftwareSchema = record({
  deviceId: z.string().uuid(),
  software: z
    .array(
      z
        .object({
          name: requiredText(255),
          version: nullableText(100),
          publisher: nullableText(255),
          installedAt: timestamp.nullable(),
        })
        .strict(),
    )
    .max(2_000),
});

const articleRecordShape = {
  name: requiredText(255),
  description: nullableText(2_000),
  content: z.string().max(250_000),
} as const;

export const breezeConfigurationPolicySchema = record(articleRecordShape);
export const breezeScriptSchema = record(articleRecordShape);
export const breezeAutomationSchema = record({
  ...articleRecordShape,
  scriptIds: z.array(z.string().uuid()).max(500),
});
export const breezeBackupConfigurationSchema = record(articleRecordShape);

export const breezeCustomFieldsSchema = record({
  deviceId: z.string().uuid(),
  fields: z
    .array(
      z
        .object({
          key: requiredText(128),
          label: requiredText(255),
          value: z.union([z.string().max(8_192), z.number(), z.boolean(), z.null()]),
        })
        .strict(),
    )
    .max(500),
});

export const breezeDeviceRelationshipsSchema = record({
  relationships: z
    .array(
      z
        .object({
          id: requiredText(128),
          sourceResourceKey: breezeResourceKeySchema,
          sourceId: requiredText(256),
          targetResourceKey: breezeResourceKeySchema,
          targetId: requiredText(256),
          type: requiredText(128),
        })
        .strict(),
    )
    .max(1_000),
});

export const breezeRecordSchemaByEndpoint: Readonly<Record<BreezeSourceEndpoint, z.ZodTypeAny>> = {
  organizations: breezeOrganizationSchema,
  sites: breezeSiteSchema,
  devices: breezeDeviceSchema,
  'device-inventory': breezeDeviceInventorySchema,
  'device-software': breezeDeviceSoftwareSchema,
  'configuration-policies': breezeConfigurationPolicySchema,
  scripts: breezeScriptSchema,
  automations: breezeAutomationSchema,
  'backup-configurations': breezeBackupConfigurationSchema,
  'custom-fields': breezeCustomFieldsSchema,
  'device-relationships': breezeDeviceRelationshipsSchema,
};

export const breezeBlockedRecordSchema = z
  .object({
    resource: breezeBlockedResourceSchema,
    id: z.string().uuid(),
    orgId: z.string().uuid(),
    reason: z.literal('secret_detected'),
    fieldPaths: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9_$.[\]-]+$/u),
      )
      .max(20),
  })
  .strict();

export type BreezeBlockedRecord = z.infer<typeof breezeBlockedRecordSchema>;
export type BreezeOrganization = z.infer<typeof breezeOrganizationSchema>;
export type BreezeRecordBase = z.infer<typeof breezeRecordBaseSchema>;

export function breezeEnvelopeSchema<T extends z.ZodTypeAny>(recordSchema: T) {
  return z
    .object({
      schemaVersion: z.literal('1'),
      snapshotAt: timestamp,
      data: z.array(recordSchema).max(500),
      nextCursor: z
        .string()
        .min(1)
        .max(4_096)
        .regex(/^[^\u0000]+$/u)
        .nullable(),
      hasMore: z.boolean(),
      blocked: z.array(breezeBlockedRecordSchema).max(500).optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.hasMore !== (value.nextCursor !== null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['nextCursor'],
          message: 'nextCursor must be present exactly when hasMore is true',
        });
      }
      const snapshotAt = Date.parse(value.snapshotAt);
      value.data.forEach((record, index) => {
        const sourceUpdatedAt = Date.parse(
          (record as { sourceUpdatedAt: string }).sourceUpdatedAt,
        );
        if (sourceUpdatedAt > snapshotAt) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['data', index, 'sourceUpdatedAt'],
            message: 'sourceUpdatedAt cannot exceed snapshotAt',
          });
        }
      });
    });
}

export interface BreezePartnerEnvelope<T> {
  schemaVersion: '1';
  snapshotAt: string;
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
  blocked?: BreezeBlockedRecord[];
}

const MAX_SANITIZE_DEPTH = 8;

/** Copy already schema-bounded JSON while removing NULs from accepted text. */
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
