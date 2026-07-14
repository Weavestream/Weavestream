import {
  createIntegrationCompanyMappingSchema,
  createIntegrationSchema,
  driverDescriptorSchema,
  driverResourceDescriptorSchema,
  fieldMappingDraftSchema,
  integrationProvenanceSchema,
  integrationReconstructionGapDtoSchema,
  integrationCompletenessResponseSchema,
  integrationCompletenessQuerySchema,
  integrationGapsPageSchema,
  integrationGapsQuerySchema,
  integrationTargetProvenanceSchema,
  updateIntegrationResourceSchema,
  integrationReconstructionGapInputSchema,
  integrationSyncMappingJobSchema,
  integrationSyncOrchestratorJobSchema,
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
  const baseDriver = {
    key: 'test',
    label: 'Test',
    description: null,
    iconKey: null,
    configFields: [],
    secretFields: [],
    capabilities: { listSourceOrgs: true, dryRun: true },
  };

  describe('driver resource descriptors', () => {
    it('keeps existing descriptors backward-compatible as asset targets', () => {
      expect(driverResourceDescriptorSchema.parse({ key: 'devices', label: 'Devices' })).toEqual({
        key: 'devices',
        label: 'Devices',
        targetKind: 'asset',
        targetConfig: {},
        dependsOnResourceKeys: [],
      });
    });

    it.each([
      ['asset', { sourceEndpoint: '/devices', bindingResourceKey: 'devices' }],
      ['subnet', { sourceEndpoint: '/device-inventory', normalization: 'cidr' }],
      ['ip_reservation', { sourceEndpoint: '/device-inventory', normalization: 'ip' }],
      [
        'article',
        {
          sourceEndpoint: '/scripts',
          folderSlug: 'rebuild-procedures',
          visibility: 'company',
          template: '# {{title}}',
        },
      ],
      ['relation', { sourceEndpoint: '/device-relationships', typeMapping: { vm: 'hosts' } }],
    ])('accepts %s-specific target configuration', (targetKind, targetConfig) => {
      expect(() =>
        driverResourceDescriptorSchema.parse({
          key: `${targetKind}s`,
          label: targetKind,
          targetKind,
          targetConfig,
        }),
      ).not.toThrow();
    });

    it('rejects configuration keys belonging to another target kind', () => {
      expect(() =>
        driverResourceDescriptorSchema.parse({
          key: 'subnets',
          label: 'Subnets',
          targetKind: 'subnet',
          targetConfig: { bindingResourceKey: 'devices' },
        }),
      ).toThrow();
    });

    it('bounds target configuration by persisted UTF-8 JSON bytes', () => {
      const article = (template: string) => ({
        key: 'articles',
        label: 'Articles',
        targetKind: 'article',
        targetConfig: { template },
      });

      // PostgreSQL renders this JSONB value as {"template": "..."}.
      expect(() => driverResourceDescriptorSchema.parse(article('x'.repeat(32_752)))).not.toThrow();
      expect(() => driverResourceDescriptorSchema.parse(article('x'.repeat(32_753)))).toThrow(
        /32768 bytes/i,
      );
      expect(() => driverResourceDescriptorSchema.parse(article('é'.repeat(16_377)))).toThrow(
        /32768 bytes/i,
      );
    });

    it('rejects missing dependencies and dependency cycles', () => {
      expect(() =>
        driverDescriptorSchema.parse({
          ...baseDriver,
          resources: [
            {
              key: 'devices',
              label: 'Devices',
              dependsOnResourceKeys: ['sites'],
            },
          ],
        }),
      ).toThrow(/dependency/i);

      expect(() =>
        driverDescriptorSchema.parse({
          ...baseDriver,
          resources: [
            { key: 'sites', label: 'Sites', dependsOnResourceKeys: ['devices'] },
            { key: 'devices', label: 'Devices', dependsOnResourceKeys: ['sites'] },
          ],
        }),
      ).toThrow(/cycle/i);
    });

    it('rejects duplicate keys, self-dependencies, and malformed keys', () => {
      expect(() =>
        driverDescriptorSchema.parse({
          ...baseDriver,
          resources: [
            { key: 'devices', label: 'Devices' },
            { key: 'devices', label: 'Duplicate' },
          ],
        }),
      ).toThrow(/unique/i);
      expect(() =>
        driverResourceDescriptorSchema.parse({
          key: 'devices',
          label: 'Devices',
          dependsOnResourceKeys: ['devices'],
        }),
      ).toThrow(/itself/i);
      expect(() =>
        driverResourceDescriptorSchema.parse({ key: 'bad key', label: 'Bad' }),
      ).toThrow();
    });
  });

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
      expect(() => createIntegrationSchema.parse({ driver: '', name: 'x' })).toThrow();
      expect(() => createIntegrationSchema.parse({ driver: 'action1', name: '' })).toThrow();
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
      expect(() => updateIntegrationSchema.parse({ status: 'ACTIVE' })).not.toThrow();
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
      expect((out as Record<string, unknown>).matchKeyFieldIds).toBeUndefined();
    });
  });

  describe('updateIntegrationCompanyMappingSchema', () => {
    it('rejects an empty patch', () => {
      expect(() => updateIntegrationCompanyMappingSchema.parse({})).toThrow(
        /At least one field must be provided/,
      );
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

    it('round-trips a manual_only mapping with a bounded transform pipeline', () => {
      const out = fieldMappingDraftSchema.parse({
        sourceField: 'os_version',
        targetFieldId: '00000000-0000-0000-0000-000000000010',
        syncDirection: 'manual_only',
        transform: { steps: [{ op: 'trim' }, { op: 'lowercase' }] },
      });
      expect(out.syncDirection).toBe('manual_only');
      expect(out.transform).toEqual({
        steps: [{ op: 'trim' }, { op: 'lowercase' }],
      });
    });

    it('requires exactly one field destination', () => {
      const base = { sourceField: 'hostname' };
      expect(() => fieldMappingDraftSchema.parse(base)).toThrow();
      expect(() =>
        fieldMappingDraftSchema.parse({
          ...base,
          targetFieldId: '00000000-0000-0000-0000-000000000010',
          targetPath: 'name',
        }),
      ).toThrow();
      expect(() => fieldMappingDraftSchema.parse({ ...base, targetPath: 'name' })).not.toThrow();
    });

    it('bounds transform steps and transform options', () => {
      const targetFieldId = '00000000-0000-0000-0000-000000000010';
      expect(() =>
        fieldMappingDraftSchema.parse({
          sourceField: 'name',
          targetFieldId,
          transform: { steps: Array.from({ length: 17 }, () => ({ op: 'trim' })) },
        }),
      ).toThrow();
      expect(() =>
        fieldMappingDraftSchema.parse({
          sourceField: 'name',
          targetFieldId,
          transform: {
            steps: [{ op: 'join', separator: 'x'.repeat(4097), paths: ['name'] }],
          },
        }),
      ).toThrow();
    });

    it('bounds the complete transform by persisted UTF-8 JSON bytes', () => {
      const targetFieldId = '00000000-0000-0000-0000-000000000010';
      const mappingWithTruthyValues = (value: string) => ({
        sourceField: 'enabled',
        targetFieldId,
        transform: {
          steps: [
            {
              op: 'to_boolean',
              truthy: Array.from({ length: 16 }, () => value),
            },
          ],
        },
      });

      expect(() =>
        fieldMappingDraftSchema.parse(mappingWithTruthyValues('x'.repeat(4096))),
      ).toThrow(/65536 bytes/i);
      expect(() =>
        fieldMappingDraftSchema.parse(mappingWithTruthyValues('é'.repeat(2048))),
      ).toThrow(/65536 bytes/i);
    });
  });

  describe('staged sync job metadata', () => {
    const job = {
      syncRunId: '00000000-0000-0000-0000-000000000001',
      integrationCompanyMappingId: '00000000-0000-0000-0000-000000000002',
      resourceId: '00000000-0000-0000-0000-000000000003',
    };

    it('preserves existing jobs with incremental mode defaults', () => {
      expect(integrationSyncMappingJobSchema.parse(job)).toMatchObject({
        ...job,
        mode: 'incremental',
      });
    });

    it('accepts bounded stage metadata and requires the current resource', () => {
      expect(() =>
        integrationSyncMappingJobSchema.parse({
          ...job,
          mode: 'full',
          stageIndex: 2,
          resourceIds: [job.resourceId],
        }),
      ).not.toThrow();
      expect(() =>
        integrationSyncMappingJobSchema.parse({
          ...job,
          resourceIds: ['00000000-0000-0000-0000-000000000004'],
        }),
      ).toThrow(/resourceId/);
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
    it('defaults manual requests to an incremental non-dry run', () => {
      expect(triggerSyncSchema.parse({})).toEqual({ dryRun: false, mode: 'incremental' });
      expect(triggerSyncSchema.parse({ mode: 'full' })).toEqual({ dryRun: false, mode: 'full' });
    });
  });

  describe('integration sync queue modes', () => {
    const integrationId = '00000000-0000-0000-0000-000000000001';
    const triggeredBy = '00000000-0000-0000-0000-000000000002';

    it('defaults manual queue jobs to incremental and permits an explicit full run', () => {
      expect(integrationSyncOrchestratorJobSchema.parse({
        kind: 'manual', integrationId, triggeredBy, syncRunId: integrationId,
      })).toMatchObject({ mode: 'incremental' });
      expect(integrationSyncOrchestratorJobSchema.parse({
        kind: 'manual', integrationId, triggeredBy, syncRunId: integrationId, mode: 'full',
      })).toMatchObject({ mode: 'full' });
    });

    it('requires an exact persisted run id for every manual orchestrator delivery', () => {
      expect(() => integrationSyncOrchestratorJobSchema.parse({
        kind: 'manual', integrationId, triggeredBy,
      })).toThrow();
    });

    it('leaves scheduled mode undecided unless the scheduler explicitly requests it', () => {
      expect(integrationSyncOrchestratorJobSchema.parse({
        kind: 'scheduled', integrationId,
      })).not.toHaveProperty('mode');
      expect(integrationSyncOrchestratorJobSchema.parse({
        kind: 'scheduled', integrationId, mode: 'full',
      })).toMatchObject({ mode: 'full' });
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
      expect(out.stale).toBe(0);
      expect(out.restored).toBe(0);
      expect(out.blocked).toBe(0);
      expect(out.secretBlocked).toBe(0);
      expect(out.missingDependency).toBe(0);
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

  describe('reconstruction provenance and gaps', () => {
    const identity = {
      companyId: '00000000-0000-0000-0000-000000000001',
      integrationCompanyMappingId: '00000000-0000-0000-0000-000000000002',
      resourceId: '00000000-0000-0000-0000-000000000003',
    };

    it('parses sanitized, bounded provenance', () => {
      expect(
        integrationProvenanceSchema.parse({
          integrationId: '00000000-0000-0000-0000-000000000004',
          externalOrgId: 'org-1',
          resourceKey: 'devices',
          externalId: 'org-1:devices:device-1',
          sourceRevision: '17',
          sourceFingerprint: null,
          firstSeenAt: '2026-07-13T12:00:00.000Z',
          lastSeenAt: '2026-07-13T12:00:00.000Z',
          lastSyncedAt: '2026-07-13T12:00:01.000Z',
          ownership: 'breeze',
          state: 'active',
        }).state,
      ).toBe('active');
    });

    it('accepts a namespaced provenance identity up to 1024 characters', () => {
      const externalOrgId = 'o'.repeat(256);
      const resourceKey = 'r'.repeat(256);
      const sourceId = 's'.repeat(256);
      const provenance = {
        integrationId: '00000000-0000-0000-0000-000000000004',
        externalOrgId,
        resourceKey,
        externalId: `${externalOrgId}:${resourceKey}:${sourceId}`,
        sourceRevision: null,
        sourceFingerprint: null,
        firstSeenAt: '2026-07-13T12:00:00.000Z',
        lastSeenAt: '2026-07-13T12:00:00.000Z',
        lastSyncedAt: '2026-07-13T12:00:01.000Z',
        ownership: 'breeze',
        state: 'active',
      };

      expect(() => integrationProvenanceSchema.parse(provenance)).not.toThrow();
      expect(() =>
        integrationProvenanceSchema.parse({ ...provenance, externalId: 'x'.repeat(1025) }),
      ).toThrow();
    });

    it('accepts bounded allowlisted gap metadata', () => {
      const input = {
        ...identity,
        externalId: null,
        kind: 'missing_dependency',
        message: 'Device binding was not found',
        details: {
          reasonCode: 'dependency_not_found',
          fieldPaths: ['network.gateway'],
          dependencyResourceKey: 'devices',
          dependencyExternalId: 'device-1',
          validationCodes: ['required'],
          unsupportedCapability: 'script_export',
          candidateCount: 2,
          sourceResource: 'scripts',
          sourceOrgId: 'org-1',
          sourceId: 'script-1',
          targetKind: 'article',
          targetId: '00000000-0000-0000-0000-000000000006',
          statusCode: 422,
          retryable: false,
          schemaVersion: 1,
        },
        firstSeenAt: '2026-07-13T12:00:00.000Z',
        lastSeenAt: '2026-07-13T12:01:00.000Z',
        resolvedAt: null,
      };
      expect(integrationReconstructionGapInputSchema.parse(input).kind).toBe('missing_dependency');
      expect(() =>
        integrationReconstructionGapDtoSchema.parse({
          id: '00000000-0000-0000-0000-000000000005',
          ...input,
        }),
      ).not.toThrow();
    });

    it('rejects oversized, unknown, and excessive gap metadata', () => {
      const input = {
        ...identity,
        externalId: null,
        kind: 'validation',
        message: 'Invalid source fields',
        details: {},
        firstSeenAt: '2026-07-13T12:00:00.000Z',
        lastSeenAt: '2026-07-13T12:01:00.000Z',
        resolvedAt: null,
      };
      expect(() =>
        integrationReconstructionGapInputSchema.parse({
          ...input,
          details: { dependencyExternalId: 'x'.repeat(4097) },
        }),
      ).toThrow();
      expect(() =>
        integrationReconstructionGapInputSchema.parse({
          ...input,
          details: { unexpectedMetadata: 'not allowlisted' },
        }),
      ).toThrow();
      expect(() =>
        integrationReconstructionGapInputSchema.parse({
          ...input,
          details: { reasonCode: undefined },
        }),
      ).toThrow();
      expect(() =>
        integrationReconstructionGapInputSchema.parse({
          ...input,
          details: { fieldPaths: Array.from({ length: 65 }, (_, index) => `field.${index}`) },
        }),
      ).toThrow();
      expect(() =>
        integrationReconstructionGapInputSchema.parse({
          ...input,
          details: { fieldPaths: ['x'.repeat(513)] },
        }),
      ).toThrow();
      expect(() =>
        integrationReconstructionGapInputSchema.parse({
          ...input,
          details: {
            fieldPaths: Array.from(
              { length: 16 },
              (_, index) => `field.${index}.${'x'.repeat(250)}`,
            ),
          },
        }),
      ).toThrow(/4096 bytes/i);
    });

    it.each([
      ['nested apiKey', { context: { auth: { apiKey: 'provider-key' } } }],
      ['nested raw payload', { metadata: { rawPayload: { host: 'device-1' } } }],
      ['authorization key', { authorization: 'Bearer header.payload.signature' }],
      ['private-key key', { privateKey: '-----BEGIN PRIVATE KEY-----' }],
      ['provider credential key', { providerCredentials: { username: 'service' } }],
      ['embedded basic credentials', { sourceId: 'https://user:password@example.test/device' }],
      ['embedded bearer token', { dependencyExternalId: 'Bearer header.payload.signature' }],
      ['token-like value', { sourceOrgId: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890' }],
    ])('rejects secret-bearing gap details: %s', (_label, details) => {
      expect(() =>
        integrationReconstructionGapInputSchema.parse({
          ...identity,
          externalId: null,
          kind: 'secret_blocked',
          message: 'Credential prevented source access',
          details,
          firstSeenAt: '2026-07-13T12:00:00.000Z',
          lastSeenAt: '2026-07-13T12:01:00.000Z',
          resolvedAt: null,
        }),
      ).toThrow();
    });
  });

  describe('admin reconstruction read DTOs', () => {
    const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;
    const counts = {
      synchronizedCurrent: 1,
      manuallyDocumented: 2,
      secretBlocked: 3,
      missing: 4,
      stale: 5,
      synchronizationError: 6,
    };

    it('parses explicit six-category completeness rows without synthesizing source data', () => {
      const response = {
        counts,
        rows: [{
          id: id('1'), companyId: id('2'), companyName: 'Acme',
          integrationCompanyMappingId: id('3'), externalOrgName: 'Acme upstream',
          resourceId: id('4'), resourceKey: 'devices', resourceLabel: 'Devices',
          counts, evaluatedAt: '2026-07-14T01:00:00.000Z',
          lastSuccessfulSyncAt: '2026-07-14T00:59:00.000Z',
        }],
      };
      expect(integrationCompletenessResponseSchema.parse(response)).toEqual(response);
      expect(() => integrationCompletenessResponseSchema.parse({ ...response, counts: { current: 1 } })).toThrow();
    });

    it('bounds and validates completeness and gap queries', () => {
      expect(integrationCompletenessQuerySchema.parse({ mappingId: id('3'), resourceId: id('4') }))
        .toEqual({ mappingId: id('3'), resourceId: id('4') });
      expect(integrationGapsQuerySchema.parse({ limit: '100', resolution: 'active' }).limit).toBe(100);
      expect(() => integrationGapsQuerySchema.parse({ limit: '101' })).toThrow();
      expect(() => integrationGapsQuerySchema.parse({ kind: 'not-a-kind' })).toThrow();
    });

    it('parses safe gap pages and target provenance while rejecting raw source values', () => {
      const target = {
        targetKind: 'asset', targetId: id('8'), targetLabel: 'HV-01',
        targetHref: `/admin/companies/${id('2')}/assets/${id('8')}`,
      };
      const provenance = {
        integrationId: id('1'), integrationName: 'Breeze',
        integrationCompanyMappingId: id('3'), resourceId: id('4'),
        sourceLabel: 'Breeze', sourceResource: 'devices', ownership: 'breeze',
        state: 'stale', firstSeenAt: '2026-07-13T00:00:00.000Z',
        lastSeenAt: '2026-07-14T00:00:00.000Z', lastSyncedAt: '2026-07-14T00:01:00.000Z',
        staleSince: '2026-07-14T00:02:00.000Z', target,
      };
      expect(integrationTargetProvenanceSchema.parse(provenance)).toEqual(provenance);
      expect(() => integrationTargetProvenanceSchema.parse({ ...provenance, rawSourceValue: 'secret' })).toThrow();

      const page = {
        items: [{
          id: id('9'), companyId: id('2'), companyName: 'Acme',
          integrationCompanyMappingId: id('3'), externalOrgName: 'Acme upstream',
          resourceId: id('4'), resourceKey: 'devices', resourceLabel: 'Devices',
          kind: 'synchronization_error', message: 'Upstream record could not be synchronized.',
          firstSeenAt: '2026-07-14T00:00:00.000Z', lastSeenAt: '2026-07-14T00:01:00.000Z',
          resolvedAt: null, target,
        }],
        nextCursor: null,
      };
      expect(integrationGapsPageSchema.parse(page)).toEqual(page);
      expect(() => integrationGapsPageSchema.parse({
        ...page,
        items: [{ ...page.items[0], details: { sourceValue: 'raw' } }],
      })).toThrow();
    });
  });

  it('accepts a bounded targetConfig patch without making targetKind operator-editable', () => {
    expect(updateIntegrationResourceSchema.parse({
      targetConfig: { folderSlug: 'procedures', visibility: 'internal' },
    })).toEqual({ targetConfig: { folderSlug: 'procedures', visibility: 'internal' } });
    expect(() => updateIntegrationResourceSchema.parse({ targetKind: 'relation' })).toThrow();
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
