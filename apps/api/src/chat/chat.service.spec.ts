import type { Prisma } from '@prisma/client';
import { chatToolCallSchema, type ChatToolCallDto } from '@weavestream/shared';
import { parseToolCalls, toMessageDto } from './chat.service.js';

const ART = '4e8c7a52-88a1-4f5e-9b1e-1a2b3c4d5e6f';
const COMPANY = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const FOLDER = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** A persisted-shape entry with sensible defaults; JSONB-typed via cast. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'call_0_abc',
    name: 'patch_article',
    arguments: { article_id: ART, edits: [{ old_text: 'a', new_text: 'b' }] },
    status: 'pending',
    result: null,
    error: null,
    errorCode: null,
    ...overrides,
  };
}

function parse(entries: unknown[]): ChatToolCallDto[] | null {
  return parseToolCalls(entries as Prisma.JsonValue);
}

describe('parseToolCalls — round-trip fidelity', () => {
  it('preserves targetCompanyId through the JSONB round-trip (the A3 reload bug)', () => {
    const out = parse([row({ targetCompanyId: COMPANY, baseRevision: 4 })]);
    expect(out).toEqual([
      expect.objectContaining({ targetCompanyId: COMPANY, baseRevision: 4 }),
    ]);
  });

  it('drops a non-uuid targetCompanyId instead of forwarding garbage', () => {
    const out = parse([row({ targetCompanyId: 'not-a-uuid' })]);
    expect(out![0]).not.toHaveProperty('targetCompanyId');
  });

  it('leaves targetCompanyId absent when the write side never attached it', () => {
    const out = parse([row()]);
    expect(out![0]).not.toHaveProperty('targetCompanyId');
  });

  it('preserves the baseRevision number/null/absent trichotomy', () => {
    const out = parse([
      row({ id: 'a', baseRevision: 7 }),
      row({ id: 'b', baseRevision: null }),
      row({ id: 'c' }),
    ]);
    expect(out![0]).toEqual(expect.objectContaining({ baseRevision: 7 }));
    expect(out![1]).toEqual(expect.objectContaining({ baseRevision: null }));
    expect(out![2]).not.toHaveProperty('baseRevision');
  });

  it('drops non-positive / non-integer baseRevision values', () => {
    const out = parse([row({ id: 'a', baseRevision: 0 }), row({ id: 'b', baseRevision: 1.5 })]);
    expect(out![0]).not.toHaveProperty('baseRevision');
    expect(out![1]).not.toHaveProperty('baseRevision');
  });

  it('preserves a valid pendingCreate idempotency record', () => {
    const marker = {
      articleId: ART,
      companyId: COMPANY,
      title: 'Rebooting the core switch',
      folderId: FOLDER,
      visibleToClients: false,
    };
    const out = parse([row({ name: 'create_article', pendingCreate: marker })]);
    expect(out![0]!.pendingCreate).toEqual(marker);
  });

  it('preserves pendingCreate with a null folderId (unfiled intent)', () => {
    const marker = {
      articleId: ART,
      companyId: COMPANY,
      title: 'Unfiled runbook',
      folderId: null,
      visibleToClients: true,
    };
    const out = parse([row({ name: 'create_article', pendingCreate: marker })]);
    expect(out![0]!.pendingCreate).toEqual(marker);
  });

  it('drops a malformed pendingCreate rather than resurrecting a broken marker', () => {
    const out = parse([
      row({ pendingCreate: { articleId: 'nope', companyId: COMPANY } }),
      row({ id: 'b', pendingCreate: 'garbage' }),
    ]);
    expect(out![0]).not.toHaveProperty('pendingCreate');
    expect(out![1]).not.toHaveProperty('pendingCreate');
  });

  it('DRIFT GUARD: every chatToolCallSchema key survives the round-trip', () => {
    // Build a DTO populating EVERY schema key with a valid value, then
    // assert each one comes back from the parser. When a field is added
    // to the schema this test fails until the parser learns it — the
    // exact failure mode that silently dropped `targetCompanyId` (A3).
    const populated: Required<ChatToolCallDto> = {
      id: 'call_0_full',
      name: 'update_article',
      arguments: { article_id: ART, markdown: '# Full' },
      status: 'pending',
      result: 'r',
      error: 'e',
      errorCode: 'stale',
      baseRevision: 12,
      targetCompanyId: COMPANY,
      pendingCreate: {
        articleId: ART,
        companyId: COMPANY,
        title: 'T',
        folderId: null,
        visibleToClients: true,
      },
    };
    // Sanity: the populated object is schema-valid before it goes in.
    expect(chatToolCallSchema.safeParse(populated).success).toBe(true);

    const out = parse([JSON.parse(JSON.stringify(populated)) as Record<string, unknown>]);
    expect(out).toHaveLength(1);
    for (const key of Object.keys(chatToolCallSchema.shape)) {
      expect(out![0]).toHaveProperty(key);
      expect((out![0] as Record<string, unknown>)[key]).toEqual(
        (populated as Record<string, unknown>)[key],
      );
    }
  });
});

describe('parseToolCalls — corrupt-row tolerance', () => {
  it('returns null for non-array json', () => {
    expect(parseToolCalls({ not: 'an array' } as Prisma.JsonValue)).toBeNull();
    expect(parseToolCalls(null)).toBeNull();
    expect(parseToolCalls('string' as unknown as Prisma.JsonValue)).toBeNull();
  });

  it('skips entries missing id/name/status and returns null when nothing survives', () => {
    expect(parse([{ name: 'search', status: 'executed' }])).toBeNull();
    expect(parse([row(), { arguments: {} }])).toHaveLength(1);
  });

  it('skips entries whose name or status is outside the shared allowlists', () => {
    expect(parse([row({ name: 'drop_table' })])).toBeNull();
    expect(parse([row({ status: 'exploded' })])).toBeNull();
  });

  it('coerces a non-object arguments blob to an empty record', () => {
    const out = parse([row({ arguments: ['array'] })]);
    expect(out![0]!.arguments).toEqual({});
  });

  it('nulls an errorCode outside the shared enum', () => {
    const out = parse([row({ errorCode: 'not_a_code' })]);
    expect(out![0]!.errorCode).toBeNull();
  });
});

describe('toMessageDto — turn scope read-back', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    role: 'ASSISTANT' as const,
    content: 'drafted',
    createdAt: new Date('2026-07-29T10:00:00.000Z'),
    toolCalls: null,
  };

  it('surfaces the turn company so a create confirmation can lock to it', () => {
    const dto = toMessageDto({
      ...base,
      turnContext: { companyId: COMPANY, currentArticleId: ART } as Prisma.JsonValue,
    });
    expect(dto.scopeCompanyId).toBe(COMPANY);
  });

  it('omits the scope for a global turn (and for legacy rows with no context)', () => {
    expect(toMessageDto({ ...base, turnContext: null })).not.toHaveProperty(
      'scopeCompanyId',
    );
    expect(toMessageDto(base)).not.toHaveProperty('scopeCompanyId');
  });
});
