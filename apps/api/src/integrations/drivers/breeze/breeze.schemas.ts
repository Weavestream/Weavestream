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
  'site-inventory': 'device-inventory',
  'device-inventory': 'device-inventory',
  'device-software': 'device-software',
  'network-equipment': 'device-inventory',
  'virtual-machines': 'device-inventory',
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

const collectionSchema = z
  .object({
    total: z.number().int().nonnegative(),
    included: z.number().int().nonnegative(),
    complete: z.boolean(),
    reason: z.literal('collection_limit_exceeded').nullable(),
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
        message: 'complete must reflect collection bounds',
      });
    }
    if ((value.reason === null) !== value.complete) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: 'reason must reflect completeness',
      });
    }
  });

const inventoryText = nullableText(1_000);
const inventoryCount = z.number().int().nonnegative().nullable();

const breezeDeviceInventoryRecordSchema = record({
  subjectType: z.literal('device'),
  deviceId: z.string().uuid(),
  hardware: z
    .object({
      processor: z
        .object({ model: inventoryText, cores: inventoryCount, threads: inventoryCount })
        .strict(),
      memory: z.object({ totalMb: inventoryCount }).strict(),
      graphics: z.object({ model: inventoryText }).strict(),
      motherboard: z
        .object({ manufacturer: inventoryText, product: inventoryText, version: inventoryText })
        .strict(),
      firmware: z.object({ biosVersion: inventoryText }).strict(),
    })
    .strict(),
  disks: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          mountPoint: z.string().max(255),
          device: inventoryText,
          fileSystem: inventoryText,
          totalGb: z.number().nonnegative(),
        })
        .strict(),
    )
    .max(500),
  interfaces: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          name: requiredText(1_000),
          macAddress: nullableText(17),
          primary: z.boolean(),
        })
        .strict(),
    )
    .max(500),
  addresses: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          interfaceId: z.string().uuid(),
          interfaceName: requiredText(1_000),
          address: requiredText(45),
          family: z.enum(['ipv4', 'ipv6']),
          assignment: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']),
          reservationEligible: z.boolean(),
          subnetMask: nullableText(45),
          gateway: nullableText(45),
          dnsServers: z.array(requiredText(45)).max(20),
          active: z.boolean(),
          firstSeenAt: timestamp,
          deactivatedAt: timestamp.nullable(),
        })
        .strict(),
    )
    .max(500),
  warranty: z
    .object({
      status: z.enum(['active', 'expiring', 'expired', 'unknown', 'subscription_active']),
      startsOn: z.string().date().nullable(),
      endsOn: z.string().date().nullable(),
      subscription: z.boolean(),
    })
    .strict()
    .nullable(),
  virtualMachines: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          externalId: requiredText(64),
          name: requiredText(256),
          generation: z.number().int().positive(),
          memoryMb: inventoryCount,
          processorCount: inventoryCount,
          rctEnabled: z.boolean(),
          passthroughDisks: z.boolean(),
        })
        .strict(),
    )
    .max(500),
  collections: z
    .object({
      disks: collectionSchema,
      interfaces: collectionSchema,
      addresses: collectionSchema,
      virtualMachines: collectionSchema,
    })
    .strict(),
});

const breezeSiteInventoryRecordSchema = record({
  subjectType: z.literal('site'),
  siteSubjectId: z.string().uuid(),
  networkEquipment: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          type: z.enum(['printer', 'router', 'switch', 'firewall', 'access_point', 'nas']),
          name: nullableText(255),
          address: requiredText(45),
          macAddress: nullableText(17),
          manufacturer: nullableText(255),
          model: nullableText(255),
        })
        .strict(),
    )
    .max(500),
  networkSegments: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          cidr: requiredText(50),
        })
        .strict(),
    )
    .max(500),
  collections: z
    .object({
      networkEquipment: collectionSchema,
      networkSegments: collectionSchema,
    })
    .strict(),
});

export const breezeDeviceInventorySchema = z.discriminatedUnion('subjectType', [
  breezeDeviceInventoryRecordSchema,
  breezeSiteInventoryRecordSchema,
]);

export const breezeDeviceSoftwareSchema = record({
  subjectType: z.literal('device'),
  deviceId: z.string().uuid(),
  software: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          name: requiredText(500),
          version: nullableText(100),
          vendor: nullableText(255),
          installedOn: z.string().date().nullable(),
          managed: z.boolean(),
        })
        .strict(),
    )
    .max(1_000),
  collection: collectionSchema,
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

const relationshipEndpointSchema = z
  .object({
    type: z.enum([
      'organization',
      'site',
      'device',
      'interface',
      'address',
      'virtual_machine',
      'discovered_asset',
    ]),
    id: z.string().uuid(),
  })
  .strict();

const relationshipEdgesSchema = z
  .array(
    z
      .object({
        key: requiredText(128),
        type: z.enum([
          'organization_site',
          'site_device',
          'device_interface',
          'interface_address',
          'hyperv_host_vm',
          'network_topology',
          'device_link',
        ]),
        from: relationshipEndpointSchema,
        to: relationshipEndpointSchema,
        metadata: z
          .object({
            interfaceName: nullableText(1_000).optional(),
            assignment: z.enum(['dhcp', 'static', 'vpn', 'link-local', 'unknown']).optional(),
            reservationEligible: z.boolean().optional(),
            connectionType: nullableText(50).optional(),
            vlan: z.number().int().min(0).max(4095).nullable().optional(),
            linkGroupRole: nullableText(16).optional(),
          })
          .strict(),
      })
      .strict(),
  )
  .max(500);

const breezeDeviceRelationshipRecordSchema = record({
  subjectType: z.literal('device'),
  deviceId: z.string().uuid(),
  edges: relationshipEdgesSchema,
  collection: collectionSchema,
});

const breezeSiteRelationshipRecordSchema = record({
  subjectType: z.literal('site'),
  siteSubjectId: z.string().uuid(),
  edges: relationshipEdgesSchema,
  collection: collectionSchema,
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
        const sourceUpdatedAt = Date.parse((record as { sourceUpdatedAt: string }).sourceUpdatedAt);
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
