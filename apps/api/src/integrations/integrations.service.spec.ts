import type { DriverDescriptor } from '@weavestream/shared';
import { validateResourceRegistry } from './integrations.service.js';

const baseDescriptor = {
  key: 'test',
  label: 'Test',
  description: null,
  iconKey: null,
  configFields: [],
  secretFields: [],
  capabilities: { kind: 'pull', listSourceOrgs: true, dryRun: true, ticketing: false },
} as const;

describe('validateResourceRegistry', () => {
  it('rejects missing writers before resource reconciliation', () => {
    const descriptor = {
      ...baseDescriptor,
      resources: [{
        key: 'subnets', label: 'Subnets', targetKind: 'subnet',
        targetConfig: { normalization: 'cidr' }, dependsOnResourceKeys: [],
      }],
    } as unknown as DriverDescriptor;

    expect(() => validateResourceRegistry(descriptor, { has: () => false })).toThrow(
      /writer.*subnet/i,
    );
  });

  it('requires bindingResourceKey to be an explicit asset dependency', () => {
    const descriptor = {
      ...baseDescriptor,
      resources: [
        { key: 'devices', label: 'Devices', targetKind: 'asset', targetConfig: {}, dependsOnResourceKeys: [] },
        { key: 'inventory', label: 'Inventory', targetKind: 'asset', targetConfig: { bindingResourceKey: 'devices' }, dependsOnResourceKeys: [] },
      ],
    } as unknown as DriverDescriptor;

    expect(() => validateResourceRegistry(descriptor, { has: () => true })).toThrow(
      /bindingResourceKey.*dependsOnResourceKeys/i,
    );
  });
});
