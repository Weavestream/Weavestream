import { z } from 'zod';
import {
  BREEZE_PRESENCE_MAX_DEPTH,
  BREEZE_PRESENCE_MAX_PATHS,
  buildPresencePlan,
  observeBreezeFields,
  observeWithPlan,
} from './breeze-field-presence.js';
import { breezeDeviceSchema, breezeRecordSchemaByEndpoint } from './breeze.schemas.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const base = {
  id: '33333333-3333-4333-8333-333333333333', orgId: ORG, siteId: null,
  sourceUpdatedAt: '2026-07-14T11:00:00.000Z', revision: 'r1',
};

function paths(endpoint: Parameters<typeof observeBreezeFields>[0], records: unknown[]) {
  return observeBreezeFields(endpoint, records);
}

function find(observed: ReturnType<typeof paths>, path: string, variant?: string) {
  return observed.find((field) => field.path === path && field.variant === variant);
}

describe('Breeze field presence', () => {
  it('derives the reported paths from the record schemas, not a second list', () => {
    const observed = paths('devices', [{ ...base, hostname: 'h1', type: {}, tags: [] }]);
    const topLevel = new Set(observed.filter((f) => !f.path.includes('.')).map((f) => f.path));
    // Every key the device schema declares is reported, and nothing else.
    expect(topLevel).toEqual(new Set(Object.keys(breezeDeviceSchema.shape)));
    // Nested section keys are reported only where the section object was sent.
    expect(find(observed, 'type.os')).toEqual({ path: 'type.os', present: 0, objects: 1 });
    expect(find(observed, 'hardwareIdentity.serialNumber')).toBeUndefined();
  });

  it('counts key presence per record variant and collapses arrays to []', () => {
    const device = {
      ...base, subjectType: 'device', deviceId: 'd1',
      addresses: [
        { id: 'a1', assignment: 'static', address: '10.0.0.5' },
        { id: 'a2', address: '10.0.0.6' },
      ],
      collections: { addresses: { total: 2, included: 2, complete: true } },
    };
    const site = {
      ...base, subjectType: 'site', siteSubjectId: 's1',
      networkEquipment: [{ id: 'e1', macAddress: null }],
    };
    const observed = paths('device-inventory', [device, { ...device, addresses: [] }, site]);

    expect(find(observed, 'addresses', 'device')).toEqual({ path: 'addresses', variant: 'device', present: 2, objects: 2 });
    expect(find(observed, 'addresses[].assignment', 'device')).toEqual({
      path: 'addresses[].assignment', variant: 'device', present: 1, objects: 2,
    });
    expect(find(observed, 'collections.addresses.total', 'device')).toMatchObject({ present: 2, objects: 2 });
    // A null value is an explicit "empty": the key counts as present.
    expect(find(observed, 'networkEquipment[].macAddress', 'site')).toMatchObject({ present: 1, objects: 1 });
    // Device paths never count site records and the other way round.
    expect(find(observed, 'addresses', 'site')).toBeUndefined();
    expect(find(observed, 'networkEquipment', 'device')).toBeUndefined();
    expect(find(observed, 'hostname', 'device')).toBeUndefined();
  });

  it('reports key paths and counts only, never values or undeclared keys', () => {
    const value = 'kJhGfDsAqWeRtYuIoPlKjHgFdSaZxCvBnMqAzWsXe';
    const policy = {
      ...base, name: value, sourceScope: 'organization', extraUpstreamKey: value,
      features: [{ id: 'f1', type: 'backup', settings: { destination: { secretAccessKey: value } } }],
    };
    const observed = paths('configuration-policies', [policy]);
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('extraUpstreamKey');
    // JSON settings are a leaf: the key is reported, nothing inside it.
    expect(find(observed, 'features[].settings')).toMatchObject({ present: 1, objects: 1 });
    expect(observed.some((f) => f.path.startsWith('features[].settings.'))).toBe(false);
    for (const field of observed) {
      expect(Object.keys(field).sort()).toEqual(
        field.variant ? ['objects', 'path', 'present', 'variant'] : ['objects', 'path', 'present'],
      );
    }
  });

  it('skips records of an undeclared variant, a missing discriminator, and non-objects', () => {
    const observed = paths('device-inventory', [
      { ...base, subjectType: 'cloud_account', addresses: [] },
      { ...base, addresses: [] },
      null,
      'text',
    ]);
    expect(observed).toEqual([]);
  });

  it('bounds the number of paths and the nesting depth', () => {
    const wide = z.object(Object.fromEntries(
      Array.from({ length: BREEZE_PRESENCE_MAX_PATHS + 100 }, (_, i) => [`k${i}`, z.string().nullish()]),
    ));
    const widePlan = buildPresencePlan(wide);
    const record = Object.fromEntries(Array.from({ length: BREEZE_PRESENCE_MAX_PATHS + 100 }, (_, i) => [`k${i}`, 'x']));
    expect(observeWithPlan(widePlan, [record])).toHaveLength(BREEZE_PRESENCE_MAX_PATHS);

    let deep: z.ZodTypeAny = z.object({ leaf: z.string() });
    for (let i = 0; i < 12; i += 1) deep = z.object({ n: deep.nullish() });
    let nested: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 12; i += 1) nested = { n: nested };
    const observed = observeWithPlan(buildPresencePlan(deep), [nested]);
    const depths = observed.map((field) => field.path.split('.').length);
    expect(Math.max(...depths)).toBe(BREEZE_PRESENCE_MAX_DEPTH + 1);
    expect(observed.some((field) => field.path.endsWith('leaf'))).toBe(false);
  });

  it('has a plan for every Breeze endpoint within the path bound', () => {
    for (const schema of Object.values(breezeRecordSchemaByEndpoint)) {
      const plan = buildPresencePlan(schema);
      expect(plan.shapes.size).toBeGreaterThan(0);
    }
    const inventory = buildPresencePlan(breezeRecordSchemaByEndpoint['device-inventory']);
    expect(inventory.discriminator).toBe('subjectType');
    expect([...inventory.shapes.keys()].sort()).toEqual(['device', 'site']);
    const backups = buildPresencePlan(breezeRecordSchemaByEndpoint['backup-configurations']);
    expect([...backups.shapes.keys()].sort()).toEqual(['destination', 'policy', 'profile']);
  });
});
