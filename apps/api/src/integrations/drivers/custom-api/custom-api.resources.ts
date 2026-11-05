import type { DriverDescriptor } from '@weavestream/shared';

/**
 * The one resource of a Custom API integration: the records the API
 * lists. The admin picks any asset layout on its tab and maps each field;
 * the driver adds no record type of its own (no device rules).
 */

export const CUSTOM_API_DRIVER_KEY = 'custom-api';

/** Fixed source field an item is matched on, when the definition sets a match path. */
export const ITEMS_MATCH_FIELD = 'match_key';

export const CUSTOM_API_RESOURCES: DriverDescriptor['resources'] = [
  {
    key: 'items',
    label: 'Items',
    description: 'The records this API lists. Pick an asset layout and map each field on this tab.',
    defaultMatchKeyHint: ITEMS_MATCH_FIELD,
    // Link to an asset the admin already has when the match keys are equal.
    matchFirst: true,
    targetKind: 'asset',
    targetConfig: {},
    dependsOnResourceKeys: [],
  },
];
