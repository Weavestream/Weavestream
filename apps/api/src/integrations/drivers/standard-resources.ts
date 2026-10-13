import { sourceFieldSchema, type DriverDescriptor, type DriverStandardField, type SourceFieldDto } from '@weavestream/shared';
import { assertRecommendedDestinations } from './driver-utils.js';
import type { RecommendedDestination, RecommendedDestinationField } from './integration-driver.js';

/**
 * The standard pattern for asset resources (Level, Google Workspace,
 * Microsoft 365): records match an existing layout by one key (Map
 * layouts), only the name and that key are written as minimal fields,
 * shared facts fill layout fields from the catalog below, and everything
 * else goes into the read-only section.
 *
 * Drivers that fill the same fact take the same catalog entry. Map layouts
 * then pre-selects the same layout field for each of them, so the priority
 * order and Differences compare like with like when several integrations
 * share one asset. Override only the label (`{ ...STANDARD_FIELDS.x, label }`)
 * when the source is narrower than the catalog fact.
 */
export type StandardField = Readonly<Omit<DriverStandardField, 'fieldHints'>> & { readonly fieldHints: readonly string[] };

export const STANDARD_FIELDS = {
  hostname: { sourceField: 'hostname', label: 'Hostname', fieldType: 'TEXT', fieldHints: ['hostname', 'host_name', 'computer_name', 'device_name'] },
  manufacturer: { sourceField: 'manufacturer', label: 'Manufacturer', fieldType: 'TEXT', fieldHints: ['manufacturer', 'make', 'vendor', 'brand'] },
  model: { sourceField: 'model', label: 'Model', fieldType: 'TEXT', fieldHints: ['model'] },
  operating_system: { sourceField: 'operating_system', label: 'Operating system', fieldType: 'TEXT', fieldHints: ['operating_system', 'os'] },
  cpu: { sourceField: 'cpu', label: 'CPU', fieldType: 'TEXT', fieldHints: ['cpu', 'processor'] },
  ram: { sourceField: 'ram', label: 'RAM', fieldType: 'TEXT', fieldHints: ['ram', 'memory'] },
  storage: { sourceField: 'storage', label: 'Storage', fieldType: 'TEXT', fieldHints: ['storage', 'disk', 'disks'] },
  mac_address: { sourceField: 'mac_address', label: 'MAC address', fieldType: 'TEXT', fieldHints: ['mac_address', 'mac'] },
  ip_address: { sourceField: 'ip_address', label: 'IP address', fieldType: 'IP_ADDRESS', fieldHints: ['ip_address', 'ip', 'private_ip'] },
  role: { sourceField: 'role', label: 'Role', fieldType: 'TEXT', fieldHints: ['role'] },
  imei: { sourceField: 'imei', label: 'IMEI', fieldType: 'TEXT', fieldHints: ['imei'] },
  phone_number: { sourceField: 'phone_number', label: 'Phone number', fieldType: 'PHONE', fieldHints: ['phone_number', 'phone', 'mobile_number'] },
  job_title: { sourceField: 'job_title', label: 'Job title', fieldType: 'TEXT', fieldHints: ['job_title', 'title'] },
  department: { sourceField: 'department', label: 'Department', fieldType: 'TEXT', fieldHints: ['department'] },
  phone: { sourceField: 'phone', label: 'Phone', fieldType: 'PHONE', fieldHints: ['phone', 'phone_number', 'work_phone'] },
  description: { sourceField: 'description', label: 'Description', fieldType: 'TEXTAREA', fieldHints: ['description'] },
  primary_domain: { sourceField: 'primary_domain', label: 'Primary domain', fieldType: 'TEXT', fieldHints: ['primary_domain', 'domain'] },
} as const satisfies Record<string, StandardField>;

/** The key records are matched on; `fieldHints` pre-select the layout field. */
export interface StandardMatchKey {
  field: string;
  label: string;
  type: 'TEXT' | 'EMAIL';
  fieldHints: readonly string[];
}

/** Shared match keys, so the same asset is found by every driver that sees it. */
export const MATCH_KEYS = {
  serialNumber: { field: 'serialNumber', label: 'Serial number', type: 'TEXT', fieldHints: ['serial_number', 'serial', 'serialnumber', 'serial_no', 'service_tag'] },
  email: { field: 'email', label: 'Email', type: 'EMAIL', fieldHints: ['email', 'primary_email', 'e_mail', 'mail', 'upn'] },
  groupEmail: { field: 'email', label: 'Email', type: 'EMAIL', fieldHints: ['email', 'group_email', 'address'] },
} as const satisfies Record<string, StandardMatchKey>;

/** Layout hints per kind of record; hint order wins, so keep shared kinds identical. */
export const LAYOUT_HINTS = {
  computers: ['workstations', 'computers', 'laptops', 'desktops', 'servers', 'devices', 'configurations'],
  phones: ['phones', 'mobile', 'mobile_devices', 'tablets'],
  people: ['people', 'contacts', 'users', 'staff', 'employees'],
  distributionLists: ['distribution_lists', 'distribution', 'groups', 'mailing_lists'],
} as const satisfies Record<string, readonly string[]>;

/** "Create a new layout" defaults for the shared kinds. */
export const STANDARD_LAYOUTS = {
  people: { name: 'People', slug: 'people', icon: 'person', color: 'blue' },
  distributionLists: { name: 'Distribution Lists', slug: 'distribution_lists', icon: 'users', color: 'teal' },
  phones: { name: 'Phones', slug: 'phones', icon: 'box', color: 'violet' },
} as const satisfies Record<string, RecommendedDestination['layout']>;

export interface StandardResourceSpec {
  label: string;
  description: string;
  match: StandardMatchKey;
  layoutHints: readonly string[];
  layout: RecommendedDestination['layout'];
  standardFields?: readonly StandardField[];
}

function destinationField(
  sourceField: string, name: string, fieldType: RecommendedDestinationField['fieldType'], isPrimary: boolean,
): RecommendedDestinationField {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return { sourceField, name, slug, fieldType, syncDirection: 'source_wins', isPrimary, showInTable: true, options: {} };
}

/** Resource descriptors for standard-pattern resources, in spec order. */
export function standardResources<K extends string>(
  specs: Readonly<Record<K, StandardResourceSpec>>,
): DriverDescriptor['resources'] {
  return (Object.keys(specs) as K[]).map((key) => {
    const spec = specs[key];
    return {
      key,
      label: spec.label,
      description: spec.description,
      defaultMatchKeyHint: spec.match.field,
      targetKind: 'asset' as const,
      targetConfig: {},
      dependsOnResourceKeys: [],
      matchSuggestions: {
        sourceField: spec.match.field,
        layoutHints: [...spec.layoutHints],
        fieldHints: [...spec.match.fieldHints],
        fieldLabel: spec.match.label,
      },
      minimalFields: spec.match.field === 'name' ? ['name'] : ['name', spec.match.field],
      ...(spec.standardFields ? { standardFields: spec.standardFields.map((field) => ({ ...field, fieldHints: [...field.fieldHints] })) } : {}),
    };
  });
}

/** "Create a new layout" for each resource: the name and the match key only. */
export function standardRecommendedDestinations<K extends string>(
  driverKey: string,
  specs: Readonly<Record<K, StandardResourceSpec>>,
): Readonly<Record<string, RecommendedDestination>> {
  const out: Record<string, RecommendedDestination> = {};
  for (const key of Object.keys(specs) as K[]) {
    const { layout, match } = specs[key];
    const fields = match.field === 'name'
      ? [destinationField('name', match.label, 'TEXT', true)]
      : [destinationField('name', 'Name', 'TEXT', true), destinationField(match.field, match.label, match.type, false)];
    out[key] = { layout, fields };
  }
  return assertRecommendedDestinations(driverKey, out);
}

const HINT_TYPES: ReadonlySet<string> = new Set(sourceFieldSchema.shape.hintType.unwrap().options);

/**
 * Source fields of a standard resource: the name, the match key, any
 * driver-specific `extras`, then the standard facts (hint type = the
 * fact's field type when the picker knows it, else TEXT).
 */
export function standardSourceFields(
  spec: StandardResourceSpec,
  opts: { matchAlwaysPresent: boolean; extras?: readonly SourceFieldDto[] },
): SourceFieldDto[] {
  const { match } = spec;
  const fields: SourceFieldDto[] = [{ key: 'name', label: match.field === 'name' ? match.label : 'Name', hintType: 'TEXT', alwaysPresent: true }];
  if (match.field !== 'name') {
    fields.push({ key: match.field, label: match.label, hintType: match.type, alwaysPresent: opts.matchAlwaysPresent });
  }
  fields.push(...(opts.extras ?? []));
  for (const field of spec.standardFields ?? []) {
    fields.push({
      key: field.sourceField,
      label: field.label,
      hintType: HINT_TYPES.has(field.fieldType) ? (field.fieldType as SourceFieldDto['hintType']) : 'TEXT',
      alwaysPresent: false,
    });
  }
  return fields;
}
