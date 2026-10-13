import { driverDescriptorSchema } from '@weavestream/shared';
import { IntegrationDriverRegistry } from './integration-driver.registry.js';
import { STANDARD_FIELDS } from './standard-resources.js';
import { integrationAssetExternalSource } from '../integration-asset-source.js';

/**
 * Every registered driver against the integration standard (see
 * standard-resources.ts). A new driver that opts into Map layouts
 * (`matchSuggestions`) must follow the whole pattern, so shared assets,
 * Differences and the priority order work across integrations.
 */
const registry = new IntegrationDriverRegistry();
const descriptors = registry.list();
const pullDrivers = descriptors.filter((d) => registry.kindOf(d.key) === 'pull').map((d) => registry.get(d.key));
const standardDrivers = pullDrivers.filter((driver) => driver.descriptor.resources.some((r) => r.matchSuggestions));
const catalog: Readonly<Record<string, (typeof STANDARD_FIELDS)[keyof typeof STANDARD_FIELDS]>> = STANDARD_FIELDS;

describe('integration driver conformance', () => {
  it.each(descriptors.map((d) => [d.key, d] as const))('%s: descriptor validates against the shared schema', (_key, descriptor) => {
    expect(() => driverDescriptorSchema.parse(descriptor)).not.toThrow();
  });

  it('has standard-pattern drivers to check', () => {
    expect(standardDrivers.map((d) => d.key).sort()).toEqual(expect.arrayContaining(['google-workspace', 'level', 'microsoft-365']));
  });

  describe.each(standardDrivers.map((d) => [d.key, d] as const))('%s', (key, driver) => {
    it('ships a setup guide and a "Check setup" diagnose', () => {
      expect(driver.descriptor.setupGuide).toBeDefined();
      expect(typeof driver.diagnose).toBe('function');
    });

    it('owns its assets under the driver key, so other integrations can co-bind them', () => {
      expect(integrationAssetExternalSource(key, 'any-integration-id')).toBe(key);
    });

    const resources = driver.descriptor.resources.filter((r) => r.matchSuggestions);
    describe.each(resources.map((r) => [r.key, r] as const))('resource %s', (resourceKey, resource) => {
      const match = resource.matchSuggestions!.sourceField;

      it('writes only the name and the match key as minimal fields', () => {
        expect(resource.minimalFields).toEqual(match === 'name' ? ['name'] : ['name', match]);
      });

      it('recommends a new layout with exactly the minimal fields', () => {
        const destination = driver.recommendedDestinations?.[resourceKey];
        expect(destination?.fields.map((f) => f.sourceField)).toEqual(resource.minimalFields);
      });

      it('declares standard facts, none of them the match key', () => {
        expect(resource.standardFields?.length ?? 0).toBeGreaterThan(0);
        expect(resource.standardFields!.map((f) => f.sourceField)).not.toContain(match);
      });

      it('never offers a standard fact\'s field as the match field', () => {
        // Otherwise Map layouts pre-selects one layout field for both (an
        // IMEI field as the serial match key), and the match value
        // overwrites the fact.
        const matchHints = new Set(resource.matchSuggestions!.fieldHints);
        for (const field of resource.standardFields ?? []) {
          expect([field.sourceField, ...field.fieldHints].filter((hint) => matchHints.has(hint))).toEqual([]);
        }
      });

      it('takes shared facts from the catalog (type and hints; only the label may differ)', () => {
        for (const field of resource.standardFields ?? []) {
          const shared = catalog[field.sourceField];
          if (!shared) continue;
          expect({ sourceField: field.sourceField, fieldType: field.fieldType, fieldHints: field.fieldHints })
            .toEqual({ sourceField: shared.sourceField, fieldType: shared.fieldType, fieldHints: [...shared.fieldHints] });
        }
      });
    });
  });
});
