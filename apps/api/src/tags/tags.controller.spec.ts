import { TagsController } from './tags.controller.js';
import type { TagsService } from './tags.service.js';
import type { AuthedUser } from '../common/current-user.decorator.js';
import type { Request } from 'express';

const ACTOR: AuthedUser = {
  id: 'u-1',
  email: 'op@example.com',
  role: 'OPERATOR',
} as unknown as AuthedUser;

function makeReq(): Request {
  return {
    ip: '10.0.0.1',
    headers: { 'user-agent': 'jest/1' },
  } as unknown as Request;
}

function makeService() {
  return {
    list: jest.fn(),
    create: jest.fn(),
    rename: jest.fn(),
    remove: jest.fn(),
  } as unknown as jest.Mocked<TagsService>;
}

describe('TagsController', () => {
  it('GET /tags coerces limit/offset and forwards q', async () => {
    const svc = makeService();
    (svc.list as jest.Mock).mockResolvedValue([{ id: 't-1', name: 'A' }]);
    const ctrl = new TagsController(svc);
    const out = await ctrl.list('prod', '20', '40');
    expect(svc.list).toHaveBeenCalledWith({ q: 'prod', limit: 20, offset: 40 });
    expect(out).toEqual({ items: [{ id: 't-1', name: 'A' }] });
  });

  it('GET /tags leaves limit/offset undefined when omitted', async () => {
    const svc = makeService();
    (svc.list as jest.Mock).mockResolvedValue([]);
    const ctrl = new TagsController(svc);
    await ctrl.list();
    expect(svc.list).toHaveBeenCalledWith({
      q: undefined,
      limit: undefined,
      offset: undefined,
    });
  });

  it('POST /tags forwards the trimmed name + audit metadata', async () => {
    const svc = makeService();
    (svc.create as jest.Mock).mockResolvedValue({ id: 't-1', name: 'Production' });
    const ctrl = new TagsController(svc);
    const out = await ctrl.create(ACTOR, { name: 'Production' }, makeReq());
    expect(svc.create).toHaveBeenCalledWith(
      ACTOR,
      'Production',
      expect.objectContaining({ ip: '10.0.0.1', userAgent: 'jest/1' }),
    );
    expect(out).toEqual({ id: 't-1', name: 'Production' });
  });

  it('PATCH /tags/:id forwards id + name', async () => {
    const svc = makeService();
    (svc.rename as jest.Mock).mockResolvedValue({ id: 't-1', name: 'Prod' });
    const ctrl = new TagsController(svc);
    await ctrl.rename(ACTOR, 't-1', { name: 'Prod' }, makeReq());
    expect(svc.rename).toHaveBeenCalledWith(
      ACTOR,
      't-1',
      'Prod',
      expect.any(Object),
    );
  });

  it('DELETE /tags/:id forwards id + audit metadata', async () => {
    const svc = makeService();
    (svc.remove as jest.Mock).mockResolvedValue(undefined);
    const ctrl = new TagsController(svc);
    await ctrl.remove(ACTOR, 't-1', makeReq());
    expect(svc.remove).toHaveBeenCalledWith(
      ACTOR,
      't-1',
      expect.any(Object),
    );
  });

  it('audit meta uses req.ip and ignores a directly-supplied X-Forwarded-For', async () => {
    // Pre-Phase 3 the controllers hand-parsed `x-forwarded-for` and
    // accepted whatever the client sent — directly hitting the API
    // (no trusted proxy in front) let an attacker forge their own IP
    // for audit attribution and per-IP rate limiting. Now every
    // controller goes through `requestMetaOf` which only reads
    // `req.ip`, the value Express resolves *after* honoring
    // `app.set('trust proxy', N)`. In this unit test the request is
    // synthesized directly (no proxy), so a forged XFF must be
    // ignored and the test sees the value `req.ip` was set to.
    const svc = makeService();
    (svc.create as jest.Mock).mockResolvedValue({ id: 't-1', name: 'A' });
    const ctrl = new TagsController(svc);
    const req = {
      ip: '10.0.0.1',
      headers: {
        'x-forwarded-for': '203.0.113.4, 10.0.0.5',
        'user-agent': 'jest/1',
      },
    } as unknown as Request;
    await ctrl.create(ACTOR, { name: 'X' }, req);
    expect(svc.create).toHaveBeenCalledWith(
      ACTOR,
      'X',
      expect.objectContaining({ ip: '10.0.0.1' }),
    );
  });
});
