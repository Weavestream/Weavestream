import {
  createIntegrationCompanyMappingSchema,
  createIntegrationSchema,
  fieldMappingDraftSchema,
  integrationSyncDirectionSchema,
  replaceFieldMappingsSchema,
  syncRunConflictSchema,
  syncRunTotalsSchema,
  triggerSyncSchema,
  updateIntegrationCompanyMappingSchema,
  updateIntegrationSchema,
} from '@weavestream/shared';

/**
 * Phase 11 — schema-shape regression tests.
 *
 * The integration controller delegates input validation to these
 * Zod schemas, so a regression here would silently accept bad data
 * (or break the admin UI). We check the boundary cases the runtime
 * relies on: defaults, refinements, and JSONB-shaped payloads.
 */
describe('integration zod schemas', () => {
  describe('createIntegrationSchema', () => {
    it('applies defaults for status / config and ignores layout-level inputs', () => {
      const out = createIntegrationSchema.parse({
        driver: 'action1',
        name: 'Action1 Production',
      });
      expect(out.status).toBe('PAUSED');
      expect(out.config).toEqual({});
      expect(out.secret).toBeUndefined();
      expect(out.syncCron).toBeUndefined();
      // Layout / match-keys are PER-RESOURCE after the resource refactor
      // (Phase 11.1) — the create flow seeds resources from the driver
      // descriptor and the per-resource PATCH endpoint configures the
      // layout/match keys.
      expect((out as Record<string, unknown>).assetLayoutId).toBeUndefined();
      expect((out as Record<string, unknown>).matchKeyFieldIds).toBeUndefined();
    });

    it('rejects an empty driver / name', () => {
      expect(() =>
        createIntegrationSchema.parse({ driver: '', name: 'x' }),
      ).toThrow();
      expect(() =>
        createIntegrationSchema.parse({ driver: 'action1', name: '' }),
      ).toThrow();
    });

    it('rejects names longer than 100 chars', () => {
      expect(() =>
        createIntegrationSchema.parse({
          driver: 'action1',
          name: 'x'.repeat(101),
        }),
      ).toThrow();
    });

    it('strips legacy layout / match-key inputs from the create payload', () => {
      const out = createIntegrationSchema.parse({
        driver: 'action1',
        name: 'A1',
        assetLayoutId: '00000000-0000-0000-0000-000000000002',
        matchKeyFieldIds: ['not-a-uuid'],
      });
      expect((out as Record<string, unknown>).assetLayoutId).toBeUndefined();
      expect((out as Record<string, unknown>).matchKeyFieldIds).toBeUndefined();
    });
  });

  describe('updateIntegrationSchema', () => {
    it('rejects an empty patch (refinement)', () => {
      expect(() => updateIntegrationSchema.parse({})).toThrow(
        /At least one field must be provided/,
      );
    });

    it('accepts a single-field patch', () => {
      expect(() =>
        updateIntegrationSchema.parse({ status: 'ACTIVE' }),
      ).not.toThrow();
    });
  });

  describe('createIntegrationCompanyMappingSchema', () => {
    it('applies defaults for enabled / filter (no layout/match-keys here)', () => {
      const out = createIntegrationCompanyMappingSchema.parse({
        companyId: '00000000-0000-0000-0000-000000000001',
        externalOrgId: 'org-99',
      });
      expect(out.enabled).toBe(true);
      expect(out.filter).toEqual({});
      // Layout / match-keys are configured on the Integration, not
      // per company mapping — schema rejects them as unknown keys via
      // Zod's default strict pass-through (extras are stripped).
      expect((out as Record<string, unknown>).assetLayoutId).toBeUndefined();
      expect(
        (out as Record<string, unknown>).matchKeyFieldIds,
      ).toBeUndefined();
    });
  });

  describe('updateIntegrationCompanyMappingSchema', () => {
    it('rejects an empty patch', () => {
      expect(() =>
        updateIntegrationCompanyMappingSchema.parse({}),
      ).toThrow(/At least one field must be provided/);
    });
  });

  describe('fieldMappingDraftSchema', () => {
    it('defaults syncDirection to source_wins', () => {
      const out = fieldMappingDraftSchema.parse({
        sourceField: 'hostname',
        targetFieldId: '00000000-0000-0000-0000-000000000010',
      });
      expect(out.syncDirection).toBe('source_wins');
      expect(out.transform).toBeUndefined();
    });

    it('round-trips a manual_only mapping with a transform blob', () => {
      const out = fieldMappingDraftSchema.parse({
        sourceField: 'os_version',
        targetFieldId: '00000000-0000-0000-0000-000000000010',
        syncDirection: 'manual_only',
        transform: { kind: 'lowercase' },
      });
      expect(out.syncDirection).toBe('manual_only');
      expect(out.transform).toEqual({ kind: 'lowercase' });
    });
  });

  describe('replaceFieldMappingsSchema', () => {
    it('accepts an empty mappings array (clears mappings)', () => {
      const out = replaceFieldMappingsSchema.parse({ mappings: [] });
      expect(out.mappings).toEqual([]);
    });
  });

  describe('integrationSyncDirectionSchema', () => {
    it('rejects unknown directions', () => {
      expect(() => integrationSyncDirectionSchema.parse('overwrite')).toThrow();
    });
    it('accepts the three documented directions', () => {
      for (const v of ['source_wins', 'preserve_manual', 'manual_only']) {
        expect(integrationSyncDirectionSchema.parse(v)).toBe(v);
      }
    });
  });

  describe('triggerSyncSchema', () => {
    it('defaults dryRun to false', () => {
      expect(triggerSyncSchema.parse({})).toEqual({ dryRun: false });
    });
  });

  describe('syncRunTotalsSchema', () => {
    it('defaults all counters to 0', () => {
      const out = syncRunTotalsSchema.parse({});
      expect(out.fetched).toBe(0);
      expect(out.created).toBe(0);
      expect(out.updated).toBe(0);
      expect(out.unchanged).toBe(0);
      expect(out.claimed).toBe(0);
      expect(out.archived).toBe(0);
      expect(out.skippedAmbiguous).toBe(0);
      expect(out.skippedManual).toBe(0);
      expect(out.errors).toBe(0);
      expect(out.byResource).toBeUndefined();
    });

    it('rejects negative counters', () => {
      expect(() => syncRunTotalsSchema.parse({ created: -1 })).toThrow();
    });

    it('accepts a per-resource breakdown', () => {
      const out = syncRunTotalsSchema.parse({
        fetched: 5,
        created: 2,
        byResource: {
          devices: { fetched: 3, created: 1, updated: 0, unchanged: 0 },
          clients: { fetched: 2, created: 1, updated: 0, unchanged: 0 },
        },
      });
      expect(out.byResource?.['devices']?.fetched).toBe(3);
      expect(out.byResource?.['clients']?.created).toBe(1);
    });
  });

  describe('syncRunConflictSchema', () => {
    it('round-trips an ambiguous-match conflict with candidate ids', () => {
      const out = syncRunConflictSchema.parse({
        kind: 'ambiguous_match',
        externalId: 'ext-1',
        message: '2 candidates matched on hostname',
        candidateAssetIds: [
          '00000000-0000-0000-0000-000000000010',
          '00000000-0000-0000-0000-000000000011',
        ],
      });
      expect(out.kind).toBe('ambiguous_match');
      expect(out.candidateAssetIds).toHaveLength(2);
    });

    it('rejects unknown conflict kinds', () => {
      expect(() =>
        syncRunConflictSchema.parse({
          kind: 'mystery',
          externalId: 'ext-1',
          message: 'x',
        }),
      ).toThrow();
    });
  });
});
