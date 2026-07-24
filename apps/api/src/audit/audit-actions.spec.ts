import * as auditCatalog from './audit-actions.js';

describe('reconstruction target audit catalog', () => {
  it('registers the exact generic lifecycle actions', () => {
    const integration = auditCatalog.AUDIT_ACTIONS.integration as Record<string, string>;

    expect({
      created: integration.targetCreated,
      updated: integration.targetUpdated,
      stale: integration.targetStale,
      restored: integration.targetRestored,
      blocked: integration.targetBlocked,
    }).toEqual({
      created: 'integration.target.created',
      updated: 'integration.target.updated',
      stale: 'integration.target.stale',
      restored: 'integration.target.restored',
      blocked: 'integration.target.blocked',
    });
  });

  it('builds bounded identity-only payloads for all five emitters', () => {
    const actionFor = (auditCatalog as Record<string, unknown>)[
      'integrationTargetAuditAction'
    ] as ((change: string) => string) | undefined;
    const buildAfter = (auditCatalog as Record<string, unknown>)[
      'integrationTargetAuditAfter'
    ] as ((input: Record<string, unknown>) => Record<string, unknown>) | undefined;

    expect(typeof actionFor).toBe('function');
    expect(typeof buildAfter).toBe('function');
    expect(['created', 'updated', 'stale', 'restored', 'blocked'].map((change) =>
      actionFor!(change),
    )).toEqual([
      'integration.target.created',
      'integration.target.updated',
      'integration.target.stale',
      'integration.target.restored',
      'integration.target.blocked',
    ]);

    const secret = 'ghp_auditMustNeverPersist1234567890';
    const payload = buildAfter!({
      integrationId: '00000000-0000-4000-8000-000000000001',
      integrationCompanyMappingId: '00000000-0000-4000-8000-000000000002',
      resourceId: '00000000-0000-4000-8000-000000000003',
      targetId: '00000000-0000-4000-8000-000000000004',
      targetKind: 'article',
      state: 'blocked',
      counts: { records: 9_999_999, gaps: -4 },
      reasonCategory: 'secret_blocked',
      externalId: secret,
      rawSource: { content: secret },
      rejectedValue: secret,
    });

    expect(payload).toEqual({
      integrationId: '00000000-0000-4000-8000-000000000001',
      integrationCompanyMappingId: '00000000-0000-4000-8000-000000000002',
      resourceId: '00000000-0000-4000-8000-000000000003',
      targetId: '00000000-0000-4000-8000-000000000004',
      targetKind: 'article',
      state: 'blocked',
      counts: { records: 1_000_000, gaps: 0 },
      reasonCategory: 'secret_blocked',
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });
});
