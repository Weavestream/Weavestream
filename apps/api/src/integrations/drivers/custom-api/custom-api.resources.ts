import type { DriverDescriptor } from '@weavestream/shared';
import {
  LAYOUT_HINTS,
  MATCH_KEYS,
  STANDARD_FIELDS,
  standardRecommendedDestinations,
  standardResources,
  type StandardResourceSpec,
} from '../standard-resources.js';

/**
 * The 2 fixed resources of a Custom API integration. The descriptor is
 * static; the definition in `config` says which requests and paths feed
 * each one, and turns off the one the API does not have.
 */

export const CUSTOM_API_DRIVER_KEY = 'custom-api';

/** Devices: the standard pattern (match on serial number, standard facts fill layout fields). */
export const DEVICES_SPEC: StandardResourceSpec = {
  label: 'Devices',
  description: 'Computers and other devices, matched on serial number. Standard fields fill layout fields; extra fields show on the asset page.',
  match: MATCH_KEYS.serialNumber,
  layoutHints: LAYOUT_HINTS.computers,
  layout: { name: 'Devices', slug: 'devices', icon: 'laptop', color: 'teal' },
  standardFields: [
    STANDARD_FIELDS.hostname,
    STANDARD_FIELDS.manufacturer,
    STANDARD_FIELDS.model,
    STANDARD_FIELDS.operating_system,
    STANDARD_FIELDS.cpu,
    STANDARD_FIELDS.ram,
    STANDARD_FIELDS.storage,
    STANDARD_FIELDS.mac_address,
    STANDARD_FIELDS.ip_address,
    STANDARD_FIELDS.role,
  ],
};

export const CUSTOM_API_RECOMMENDED_DESTINATIONS = standardRecommendedDestinations(CUSTOM_API_DRIVER_KEY, { devices: DEVICES_SPEC });

/** Fixed source field an Other assets record is matched on, when the definition sets a match path. */
export const OTHER_ASSETS_MATCH_FIELD = 'match_key';

export const CUSTOM_API_RESOURCES: DriverDescriptor['resources'] = [
  ...standardResources({ devices: DEVICES_SPEC }),
  {
    key: 'other_assets',
    label: 'Other assets',
    description: 'Any other record type. Every extra field is a source field you map on the field mappings tab.',
    defaultMatchKeyHint: OTHER_ASSETS_MATCH_FIELD,
    targetKind: 'asset',
    targetConfig: {},
    dependsOnResourceKeys: [],
  },
];
