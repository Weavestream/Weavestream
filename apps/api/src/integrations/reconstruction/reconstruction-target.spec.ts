import { BadRequestException, Logger } from '@nestjs/common';
import {
  MAX_RECONSTRUCTION_INPUT_BYTES,
  articleReconstructionInputSchema,
  blockedOutcome,
  buildProvenance,
  contextGap,
  invalidInputOutcome,
  nativeWriteErrorOutcome,
  reconstructionInputByteLength,
  type ArticleReconstructionInput,
  type AssetReconstructionInput,
  type ReconstructionWriteContext,
} from './reconstruction-target.js';

const ids = {
  company: '40000000-0000-0000-0000-000000000001',
  integration: '40000000-0000-0000-0000-000000000002',
  mapping: '40000000-0000-0000-0000-000000000003',
  resource: '40000000-0000-0000-0000-000000000004',
  actor: '40000000-0000-0000-0000-000000000005',
  target: '40000000-0000-0000-0000-000000000006',
  layout: '40000000-0000-0000-0000-000000000007',
};

const input: AssetReconstructionInput = {
  targetKind: 'asset',
  externalId: 'org-1:devices:device-1',
  source: { externalOrgId: 'org-1', resourceKey: 'devices', sourceId: 'device-1' },
  name: 'Device 1',
  assetLayoutId: ids.layout,
  matchKeyFieldIds: [],
  fieldValues: [],
};

function context(overrides: Partial<ReconstructionWriteContext> = {}): ReconstructionWriteContext {
  return {
    tx: {} as never,
    companyId: ids.company,
    integrationId: ids.integration,
    integrationCompanyMappingId: ids.mapping,
    resourceId: ids.resource,
    resourceKey: 'devices',
    externalOrgId: 'org-1',
    auditActorId: ids.actor,
    now: new Date('2026-07-14T00:00:00.000Z'),
    dryRun: false,
    resolveBinding: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('reconstruction safety outcomes', () => {
  it('uses one non-secret checksum sentinel for distinct rejected inputs', () => {
    const first = blockedOutcome(
      context(),
      { ...input, name: 'Bearer first-secret-value' },
      { kind: 'validation', message: 'Sensitive reconstruction input was rejected.', details: { reasonCode: 'sensitive_input' } },
    );
    const second = blockedOutcome(
      context(),
      { ...input, name: 'Bearer second-secret-value' },
      { kind: 'validation', message: 'Sensitive reconstruction input was rejected.', details: { reasonCode: 'sensitive_input' } },
    );

    expect(first.checksum).toBe(second.checksum);
    expect(first.checksum).not.toContain('first-secret-value');
    expect(second.checksum).not.toContain('second-secret-value');
  });

  it('reuses a prior successful checksum without hashing blocked input', () => {
    const previousChecksum = 'a'.repeat(64);
    const previousProvenance = buildProvenance(context(), input);
    const out = blockedOutcome(
      context({ previousChecksum, previousProvenance }),
      { ...input, name: 'Bearer rejected-secret-value' },
      { kind: 'validation', message: 'Rejected.', details: { reasonCode: 'sensitive_input' } },
    );
    expect(out.checksum).toBe(previousChecksum);
  });

  it('preserves the last successful sync time when a later attempt is blocked', () => {
    const previousProvenance = buildProvenance(
      context({ now: new Date('2026-07-13T00:00:00.000Z') }),
      input,
    );
    const blocked = buildProvenance(context({ previousProvenance }), input, 'blocked');
    expect(blocked.lastSyncedAt).toBe('2026-07-13T00:00:00.000Z');
    expect(blocked.lastSeenAt).toBe('2026-07-14T00:00:00.000Z');
  });

  it('uses null successful-sync time for a never-successful blocked attempt', () => {
    expect(buildProvenance(context(), input, 'blocked').lastSyncedAt).toBeNull();
  });

  it('requires matching active Breeze provenance for an arbitrary existing target', () => {
    const gap = contextGap(context({ existingTargetId: ids.target }), input);
    expect(gap).toMatchObject({ details: { reasonCode: 'manual_ownership' } });
  });

  it('permits an exact Breeze-owned blocked binding to recover on a later valid source record', () => {
    const blocked = buildProvenance(context(), input, 'blocked');
    expect(contextGap(context({
      existingTargetId: ids.target,
      previousProvenance: blocked,
    }), input)).toBeNull();
  });

  it('does not replace manual provenance when a bound retry is malformed', () => {
    const manual = {
      ...buildProvenance(context(), input),
      ownership: 'weavestream' as const,
      externalOrgId: 'manual-org',
      resourceKey: 'manual-assets',
      externalId: 'manual-org:manual-assets:asset-1',
    };
    const out = invalidInputOutcome(
      context({ existingTargetId: ids.target, previousProvenance: manual }),
      'asset',
    );
    expect(out.provenance).toMatchObject({
      ownership: 'weavestream',
      externalOrgId: 'manual-org',
      externalId: manual.externalId,
    });
  });
});

describe('reconstruction input byte bounds', () => {
  const articleInput: ArticleReconstructionInput = {
    targetKind: 'article',
    externalId: 'org-1:procedures:article-1',
    source: {
      externalOrgId: 'org-1',
      resourceKey: 'procedures',
      sourceId: 'article-1',
    },
    title: 'Unicode boundary',
    slug: 'unicode-boundary',
    folderId: null,
    markdown: 'placeholder',
    visibleToClients: false,
  };

  function utf8Text(bytes: number): string {
    return `${'界'.repeat(Math.floor(bytes / 3))}${'a'.repeat(bytes % 3)}`;
  }

  it('accepts a non-ASCII article at the serialized UTF-8 byte ceiling', () => {
    const emptyBytes = reconstructionInputByteLength({ ...articleInput, markdown: '' });
    const candidate = {
      ...articleInput,
      markdown: utf8Text(MAX_RECONSTRUCTION_INPUT_BYTES - emptyBytes),
    };

    expect(candidate.markdown.length).toBeLessThan(MAX_RECONSTRUCTION_INPUT_BYTES);
    expect(reconstructionInputByteLength(candidate)).toBe(MAX_RECONSTRUCTION_INPUT_BYTES);
    expect(articleReconstructionInputSchema.safeParse(candidate).success).toBe(true);
  });

  it('rejects one additional UTF-8 byte even when the character count is below the ceiling', () => {
    const emptyBytes = reconstructionInputByteLength({ ...articleInput, markdown: '' });
    const candidate = {
      ...articleInput,
      markdown: utf8Text(MAX_RECONSTRUCTION_INPUT_BYTES - emptyBytes + 1),
    };

    expect(candidate.markdown.length).toBeLessThan(MAX_RECONSTRUCTION_INPUT_BYTES);
    expect(reconstructionInputByteLength(candidate)).toBe(MAX_RECONSTRUCTION_INPUT_BYTES + 1);
    expect(articleReconstructionInputSchema.safeParse(candidate).success).toBe(false);
  });
});

describe('native write failure logging', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs a non-HTTP failure by name, code, and constraint without message text, keeping the gap generic', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = Object.assign(
      new Error([
        '',
        'Invalid `tx.asset.update()` invocation:',
        '{ data: { serial: "SECRET-FIELD-VALUE", token: "tok_live_123" } }',
        'Unique constraint failed for owner jane.doe@example.com token=tok_live_456',
      ].join('\n')),
      {
        name: 'PrismaClientKnownRequestError',
        code: 'P2002',
        meta: { target: ['companyId', 'serial'], field_name: 'Asset_companyId_fkey' },
      },
    );
    const outcome = nativeWriteErrorOutcome(context(), input, error);
    expect(outcome.gaps).toEqual([expect.objectContaining({ kind: 'synchronization_error', message: 'The native target write failed.' })]);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain(
      'Native target write failed: PrismaClientKnownRequestError P2002 target=companyId,serial field=Asset_companyId_fkey (',
    );
    expect(line).toContain(`integration=${ids.integration}`);
    expect(line).toContain(`company=${ids.company}`);
    expect(line).toContain(`resource=${ids.resource}/devices`);
    expect(line).not.toMatch(/SECRET-FIELD-VALUE|tok_live|jane\.doe|example\.com|Unique constraint|org-1:devices:device-1/);
  });

  it('logs only the name of a plain error, never its message', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    nativeWriteErrorOutcome(context(), input, new TypeError('user jane.doe@example.com token=tok_live_123'));
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('Native target write failed: TypeError (');
    expect(line).not.toMatch(/jane|example\.com|tok_live/);
  });

  it('drops meta values that are not identifier-shaped', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = Object.assign(new Error('x'), {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      meta: { target: 'jane.doe@example.com', field_name: 'a b=c' },
    });
    nativeWriteErrorOutcome(context(), input, error);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toContain('PrismaClientKnownRequestError P2002 (');
    expect(line).not.toMatch(/jane|a b=c/);
  });

  it('names the failing field slugs of a native validation failure, never the issue messages', () => {
    const error = new BadRequestException({
      error: 'ValidationError',
      issues: [
        { path: 'hostname', message: 'Hostname is required' },
        { path: 'site.label', message: 'Invalid enum value, received "SECRET-VALUE"' },
        { path: 'a b=c', message: 'x' },
        { path: '', message: 'Unrecognized key(s) in object' },
      ],
    });
    const outcome = nativeWriteErrorOutcome(context(), input, error);
    expect(outcome.gaps).toEqual([{
      kind: 'validation',
      message: 'Native target validation blocked the write (fields: hostname, site).',
      details: { reasonCode: 'native_validation', fieldPaths: ['hostname', 'site'] },
    }]);
    expect(JSON.stringify(outcome)).not.toMatch(/SECRET-VALUE|required|a b=c/);
  });

  it('keeps the generic native validation gap when the failure names no fields', () => {
    const outcome = nativeWriteErrorOutcome(context(), input, new BadRequestException('Bad input'));
    expect(outcome.gaps).toEqual([{
      kind: 'validation',
      message: 'Native target validation blocked the write.',
      details: { reasonCode: 'native_validation' },
    }]);
  });

  it('does not log mapped HTTP failures', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    nativeWriteErrorOutcome(context(), input, { getStatus: () => 409 });
    expect(warn).not.toHaveBeenCalled();
  });
});
