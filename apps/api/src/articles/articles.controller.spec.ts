import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { createArticleSchema } from '@weavestream/shared';
import { ArticlesController } from './articles.controller.js';
import { ZodBody } from '../common/zod-validation.pipe.js';
import type { ArticlesService } from './articles.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';

const ACTOR: AuthedUser = {
  id: 'u-1',
  email: 'op@example.com',
  role: 'OPERATOR',
} as unknown as AuthedUser;

const COMPANY = '11111111-1111-1111-1111-111111111111';
const FOLDER = '22222222-2222-2222-2222-222222222222';

function makeService() {
  return {
    list: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
  } as unknown as jest.Mocked<ArticlesService>;
}

describe('ArticlesController list folderId validation', () => {
  it('rejects a non-UUID, non-root folderId with 400 before the service runs', async () => {
    const svc = makeService();
    const ctrl = new ArticlesController(svc);
    await expect(ctrl.list(ACTOR, COMPANY, 'bogus')).rejects.toThrow(BadRequestException);
    expect(svc.list).not.toHaveBeenCalled();
  });

  it("passes 'root' through as the unfiled sentinel", async () => {
    const svc = makeService();
    const ctrl = new ArticlesController(svc);
    await ctrl.list(ACTOR, COMPANY, 'root');
    expect(svc.list).toHaveBeenCalledWith(
      ACTOR,
      COMPANY,
      expect.objectContaining({ folderId: 'root' }),
    );
  });

  it('passes a UUID folderId through', async () => {
    const svc = makeService();
    const ctrl = new ArticlesController(svc);
    await ctrl.list(ACTOR, COMPANY, FOLDER);
    expect(svc.list).toHaveBeenCalledWith(
      ACTOR,
      COMPANY,
      expect.objectContaining({ folderId: FOLDER }),
    );
  });

  it('treats an empty folderId as not provided (pre-existing leniency)', async () => {
    const svc = makeService();
    const ctrl = new ArticlesController(svc);
    await ctrl.list(ACTOR, COMPANY, '');
    expect(svc.list).toHaveBeenCalledWith(
      ACTOR,
      COMPANY,
      expect.objectContaining({ folderId: undefined }),
    );
  });

  it('leaves an omitted folderId undefined', async () => {
    const svc = makeService();
    const ctrl = new ArticlesController(svc);
    await ctrl.list(ACTOR, COMPANY);
    expect(svc.list).toHaveBeenCalledWith(
      ACTOR,
      COMPANY,
      expect.objectContaining({ folderId: undefined }),
    );
  });
});

describe('ArticlesController create draft flag (#117)', () => {
  const REQ = { headers: {}, ip: '127.0.0.1' } as unknown as Request;
  const BODY = { title: 'Draft', editorMode: 'markdown', markdownSource: '# hi' } as const;

  it('passes draft: true through to the service as an option', async () => {
    const svc = { create: jest.fn().mockResolvedValue({}) } as unknown as jest.Mocked<ArticlesService>;
    const ctrl = new ArticlesController(svc);
    await ctrl.create(ACTOR, COMPANY, BODY, { draft: true }, REQ);
    expect(svc.create).toHaveBeenCalledWith(ACTOR, COMPANY, BODY, expect.anything(), {
      draft: true,
    });
  });

  it('creates a published article when the flag is absent', async () => {
    const svc = { create: jest.fn().mockResolvedValue({}) } as unknown as jest.Mocked<ArticlesService>;
    const ctrl = new ArticlesController(svc);
    await ctrl.create(ACTOR, COMPANY, BODY, {}, REQ);
    expect(svc.create).toHaveBeenCalledWith(ACTOR, COMPANY, BODY, expect.anything(), {
      draft: false,
    });
  });

  it('keeps the flag out of the shared create DTO', () => {
    // The shared schema is also parsed by the integration and chat create
    // paths; the flag must only reach the service through the route.
    const dto = new ZodBody(createArticleSchema).transform({ ...BODY, draft: true });
    expect(dto).not.toHaveProperty('draft');
  });
});
