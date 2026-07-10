import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@weavestream/shared';
import {
  AI_TOOL_BUDGET_MESSAGE,
  AI_TOOL_INVALID_ARGS_MESSAGE,
  AI_TOOL_UNAVAILABLE_MESSAGE,
  AiToolExecutorService,
  sha256CanonicalJson,
} from './ai-tool-executor.service.js';
import { AI_TOOL_SPECS } from './tool-specs.js';
import type { AiToolExecutionContext } from './tool-registry.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

const ARTICLE_ID = '4e8c7a52-88a1-4f5e-9b1e-1a2b3c4d5e6f';

const VALID_ARTICLE_OUTPUT = {
  id: ARTICLE_ID,
  title: 'VPN Setup',
  markdown: '# VPN Setup\n\nSteps…',
  revision: 7,
  href: `/admin/companies/c-1/articles/${ARTICLE_ID}`,
  visibleToClients: true,
  updatedAt: '2026-07-01T00:00:00.000Z',
  truncated: false,
  nextCursor: null,
};

function tenant(): TenantContext {
  return {
    userId: 'u-1',
    role: 'OPERATOR',
    email: 'op@example.com',
    allowedCompanyIds: ['c-1'],
    isSuperAdmin: false,
    globalAccess: null,
    requestId: 'req-42',
    ip: '127.0.0.1',
    userAgent: 'jest',
  };
}

function execCtx(): AiToolExecutionContext {
  return {
    actor: { id: 'u-1', role: 'OPERATOR' } as AuthedUser,
    tenant: tenant(),
    correlationId: 'req-42',
    ip: '127.0.0.1',
    userAgent: 'jest',
    conversationId: 'conv-1',
    turnContext: { companyId: 'c-1' } as never,
  };
}

function makeService(overrides: {
  resolveCompanyId?: jest.Mock;
  execute?: jest.Mock;
  budgetAllowed?: boolean;
  permissionAllowed?: boolean;
} = {}) {
  const tool = {
    spec: AI_TOOL_SPECS.get_article,
    resolveCompanyId:
      overrides.resolveCompanyId ?? jest.fn(async () => 'c-1' as const),
    execute: overrides.execute ?? jest.fn(async () => VALID_ARTICLE_OUTPUT),
  };
  const registry = {
    get: (name: string) => (name === 'get_article' ? AI_TOOL_SPECS.get_article : undefined),
    getReadTool: (name: string) => (name === 'get_article' ? tool : undefined),
  };
  const budget = {
    consume: jest.fn(async () => ({
      allowed: overrides.budgetAllowed ?? true,
      retryAfterSeconds: (overrides.budgetAllowed ?? true) ? 0 : 900,
    })),
  };
  const permissions = {
    can: jest.fn(async () => ({ allowed: overrides.permissionAllowed ?? true })),
  };
  const audit = { log: jest.fn(async (_entry: unknown) => {}) };
  const svc = new AiToolExecutorService(
     
    registry as any,
     
    budget as any,
     
    permissions as any,
     
    audit as any,
  );
  return { svc, tool, budget, permissions, audit };
}

function auditAfter(audit: { log: jest.Mock }): Record<string, unknown> {
  expect(audit.log).toHaveBeenCalledTimes(1);
  const entry = audit.log.mock.calls[0]![0] as { after: Record<string, unknown> };
  return entry.after;
}

describe('AiToolExecutorService.executeRead', () => {
  it('rejects malformed args WITHOUT consuming budget and audits with a null digest', async () => {
    const { svc, budget, audit } = makeService();
    const result = await svc.executeRead(
      'tc-1',
      'get_article',
      { article_id: 'not-a-uuid' },
      execCtx(),
    );
    expect(result).toEqual({
      ok: false,
      error: AI_TOOL_INVALID_ARGS_MESSAGE,
      errorCode: 'malformed',
    });
    expect(budget.consume).not.toHaveBeenCalled();
    const after = auditAfter(audit);
    expect(after).toEqual({
      outcome: 'invalid_args',
      correlationId: 'req-42',
      argsSha256: null,
    });
  });

  it('budget exhaustion consumes nothing further and audits with the validated-args digest', async () => {
    const { svc, tool, audit } = makeService({ budgetAllowed: false });
    const result = await svc.executeRead(
      'tc-1',
      'get_article',
      { article_id: ARTICLE_ID, cursor: null },
      execCtx(),
    );
    expect(result).toEqual({
      ok: false,
      error: AI_TOOL_BUDGET_MESSAGE,
      errorCode: 'budget',
      retryAfterSeconds: 900,
    });
    expect(tool.resolveCompanyId).not.toHaveBeenCalled();
    const after = auditAfter(audit);
    expect(after['outcome']).toBe('budget_exhausted');
    expect(after['argsSha256']).toBe(sha256CanonicalJson({ article_id: ARTICLE_ID }));
  });

  it('not-found and denied produce IDENTICAL strings but distinct audit outcomes', async () => {
    const notFound = makeService({
      resolveCompanyId: jest.fn(async () => null),
    });
    const rNotFound = await notFound.svc.executeRead(
      'tc-1',
      'get_article',
      { article_id: ARTICLE_ID },
      execCtx(),
    );

    const denied = makeService({ permissionAllowed: false });
    const rDenied = await denied.svc.executeRead(
      'tc-2',
      'get_article',
      { article_id: ARTICLE_ID },
      execCtx(),
    );

    expect(rNotFound.ok).toBe(false);
    expect(rDenied.ok).toBe(false);
    if (rNotFound.ok || rDenied.ok) throw new Error('unreachable');
    expect(rNotFound.error).toBe(AI_TOOL_UNAVAILABLE_MESSAGE);
    expect(rDenied.error).toBe(rNotFound.error);
    expect(rNotFound.errorCode).toBe('unavailable');
    expect(rDenied.errorCode).toBe('unavailable');
    expect(auditAfter(notFound.audit)['outcome']).toBe('not_found');
    expect(auditAfter(denied.audit)['outcome']).toBe('denied');
    // Denied and not-found DO consume budget — probes burn it.
    expect(notFound.budget.consume).toHaveBeenCalledTimes(1);
    expect(denied.budget.consume).toHaveBeenCalledTimes(1);
  });

  it('maps NotFound/Forbidden thrown by execute to the generic error with truthful outcomes', async () => {
    const nf = makeService({
      execute: jest.fn(async () => {
        throw new NotFoundException();
      }),
    });
    const r1 = await nf.svc.executeRead('tc-1', 'get_article', { article_id: ARTICLE_ID }, execCtx());
    expect(r1).toMatchObject({ ok: false, error: AI_TOOL_UNAVAILABLE_MESSAGE });
    expect(auditAfter(nf.audit)['outcome']).toBe('not_found');

    const fb = makeService({
      execute: jest.fn(async () => {
        throw new ForbiddenException();
      }),
    });
    const r2 = await fb.svc.executeRead('tc-1', 'get_article', { article_id: ARTICLE_ID }, execCtx());
    expect(r2).toMatchObject({ ok: false, error: AI_TOOL_UNAVAILABLE_MESSAGE });
    expect(auditAfter(fb.audit)['outcome']).toBe('denied');
  });

  it('treats an output-schema violation as an internal error, never leaking the payload', async () => {
    const { svc, audit } = makeService({
      execute: jest.fn(async () => ({ unexpected: 'shape' })),
    });
    const result = await svc.executeRead(
      'tc-1',
      'get_article',
      { article_id: ARTICLE_ID },
      execCtx(),
    );
    expect(result).toMatchObject({
      ok: false,
      error: AI_TOOL_UNAVAILABLE_MESSAGE,
      errorCode: 'unavailable',
    });
    expect(auditAfter(audit)['outcome']).toBe('error');
  });

  it('happy path: validated output, payload JSON, spec summary, ok audit row', async () => {
    const { svc, audit } = makeService();
    const result = await svc.executeRead(
      'tc-9',
      'get_article',
      { article_id: ARTICLE_ID, cursor: null },
      execCtx(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.output).toEqual(VALID_ARTICLE_OUTPUT);
    expect(result.payloadJson).toBe(JSON.stringify(VALID_ARTICLE_OUTPUT));
    expect(result.summary).toBe('Read "VPN Setup" (revision 7)');

    expect(audit.log).toHaveBeenCalledTimes(1);
    const entry = audit.log.mock.calls[0]![0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      actorId: 'u-1',
      action: 'ai_tool.get_article',
      entityType: 'AiTool',
      entityId: 'tc-9',
      companyId: 'c-1',
    });
    expect(entry['after']).toEqual({
      outcome: 'ok',
      correlationId: 'req-42',
      argsSha256: sha256CanonicalJson({ article_id: ARTICLE_ID }),
    });
    // Never content: the audit row must not embed args or results.
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('VPN Setup');
    expect(serialized).not.toContain(ARTICLE_ID.slice(0, 8));
  });

  it('every exit path writes exactly one audit row', async () => {
    // Sampled across the six paths above via auditAfter's
    // toHaveBeenCalledTimes(1); this case covers the happy path twice
    // to prove rows are per-invocation, not per-service.
    const { svc, audit } = makeService();
    await svc.executeRead('tc-1', 'get_article', { article_id: ARTICLE_ID }, execCtx());
    await svc.executeRead('tc-2', 'get_article', { article_id: ARTICLE_ID }, execCtx());
    expect(audit.log).toHaveBeenCalledTimes(2);
  });
});

describe('sha256CanonicalJson', () => {
  it('is key-order independent and undefined-stripping', () => {
    expect(sha256CanonicalJson({ b: 1, a: 2 })).toBe(sha256CanonicalJson({ a: 2, b: 1 }));
    expect(sha256CanonicalJson({ a: 2, b: 1, c: undefined })).toBe(
      sha256CanonicalJson({ b: 1, a: 2 }),
    );
    expect(sha256CanonicalJson({ a: 1 })).not.toBe(sha256CanonicalJson({ a: 2 }));
  });
});
