import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { oauthAdapterFactory } from './oauth-adapter.js';

type Row = {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  grantId: string | null;
  uid: string | null;
  expiresAt: Date | null;
  consumedAt: Date | null;
};

/** In-memory stand-in for the `oauth_artifacts` table. */
function makeFixture() {
  const rows = new Map<string, Row>();
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'id' && v && typeof v === 'object' && 'in' in v) return (v as { in: string[] }).in.includes(row.id);
      if (k === 'expiresAt' && v && typeof v === 'object' && 'lt' in v) {
        return row.expiresAt !== null && row.expiresAt < (v as { lt: Date }).lt;
      }
      return (row as unknown as Record<string, unknown>)[k] === v;
    });
  const prisma = {
    oAuthArtifact: {
      upsert: jest.fn(async ({ where, create, update }: { where: { id: string }; create: Row; update: Partial<Row> }) => {
        const existing = rows.get(where.id);
        rows.set(where.id, existing ? { ...existing, ...update } : { ...create, consumedAt: create.consumedAt ?? null });
      }),
      // Like the real table: a duplicate primary key fails with P2002.
      create: jest.fn(async ({ data }: { data: Row }) => {
        if (rows.has(data.id)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        rows.set(data.id, { ...data, consumedAt: null });
      }),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].find((r) => matches(r, where)) ?? null,
      ),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...rows.values()].filter((r) => matches(r, where)).map((r) => ({ id: r.id })),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        let count = 0;
        for (const r of rows.values()) {
          if (!matches(r, where)) continue;
          Object.assign(r, data);
          count += 1;
        }
        return { count };
      }),
      deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        let count = 0;
        for (const [id, r] of rows) {
          if (!matches(r, where)) continue;
          rows.delete(id);
          count += 1;
        }
        return { count };
      }),
    },
  };
  const onReplay = jest.fn().mockResolvedValue(undefined);
  class InvalidGrant extends Error {}
  class InvalidClientAuth extends Error {}
  const adapter = oauthAdapterFactory({
    prisma: prisma as never,
    invalidGrant: (d) => new InvalidGrant(d),
    invalidClientAuth: (d) => new InvalidClientAuth(d),
    onReplay,
  });
  return { rows, prisma, onReplay, adapter, InvalidGrant, InvalidClientAuth };
}

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const TOKEN = 'opaque-refresh-token-value-0123456789abcdef';

describe('PrismaOAuthAdapter', () => {
  it('keys bearer rows by the hash of the value and never stores the value', async () => {
    const { rows, adapter } = makeFixture();
    const refresh = adapter('RefreshToken');
    await refresh.upsert(TOKEN, { jti: TOKEN, grantId: 'g-1', accountId: 'u-1' } as never, 3600);

    const [id, row] = [...rows.entries()][0]!;
    expect(id).toBe(`RefreshToken:${sha256(TOKEN)}`);
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(row.grantId).toBe('g-1');
    // The presented value is what restores `jti`.
    await expect(refresh.find(TOKEN)).resolves.toMatchObject({ jti: TOKEN, grantId: 'g-1' });
    await expect(refresh.find('some-other-value')).resolves.toBeUndefined();
  });

  it('keeps sessions whole so findByUid returns the original id', async () => {
    const { rows, adapter } = makeFixture();
    const session = adapter('Session');
    await session.upsert('sess-1', { jti: 'sess-1', uid: 'uid-1', accountId: 'u-1' } as never, 600);

    expect(rows.has('Session:sess-1')).toBe(true);
    await expect(session.findByUid('uid-1')).resolves.toMatchObject({ jti: 'sess-1', uid: 'uid-1' });
    await expect(adapter('Interaction').findByUid('uid-1')).resolves.toBeUndefined();
  });

  it('files a grant under its own id, so deleting by grant id removes it', async () => {
    const { rows, adapter } = makeFixture();
    await adapter('Grant').upsert('g-1', { jti: 'g-1', accountId: 'u-1' } as never, 3600);
    expect(rows.get('Grant:g-1')!.grantId).toBe('g-1');
  });

  it('ignores expired rows', async () => {
    const { rows, adapter } = makeFixture();
    const access = adapter('AccessToken');
    await access.upsert('at', { jti: 'at', grantId: 'g-1' } as never, 3600);
    rows.get(`AccessToken:${sha256('at')}`)!.expiresAt = new Date(Date.now() - 1000);
    await expect(access.find('at')).resolves.toBeUndefined();
  });

  it('consumes once; a second consume revokes the whole grant and fails', async () => {
    const { rows, adapter, onReplay, InvalidGrant } = makeFixture();
    const code = adapter('AuthorizationCode');
    await code.upsert('code-1', { jti: 'code-1', grantId: 'g-1' } as never, 60);
    await adapter('AccessToken').upsert('at-1', { jti: 'at-1', grantId: 'g-1' } as never, 3600);
    await adapter('Grant').upsert('g-1', { jti: 'g-1' } as never, 3600);
    await adapter('AccessToken').upsert('at-2', { jti: 'at-2', grantId: 'g-2' } as never, 3600);

    await code.consume('code-1');
    await expect(code.find('code-1')).resolves.toMatchObject({ consumed: expect.any(Number) });

    await expect(code.consume('code-1')).rejects.toBeInstanceOf(InvalidGrant);
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(onReplay).toHaveBeenCalledWith('g-1');
    // Everything of grant g-1 is gone, grant g-2 is untouched.
    expect([...rows.keys()]).toEqual([`AccessToken:${sha256('at-2')}`]);
  });

  it('of two simultaneous consumes exactly one wins', async () => {
    const { adapter, onReplay } = makeFixture();
    const refresh = adapter('RefreshToken');
    await refresh.upsert(TOKEN, { jti: TOKEN, grantId: 'g-1' } as never, 3600);

    const results = await Promise.allSettled([refresh.consume(TOKEN), refresh.consume(TOKEN)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(onReplay).toHaveBeenCalledWith('g-1');
  });

  it('revokeByGrantId deletes only its own model\'s rows', async () => {
    const { rows, adapter } = makeFixture();
    await adapter('AccessToken').upsert('at', { jti: 'at', grantId: 'g-1' } as never, 3600);
    await adapter('RefreshToken').upsert('rt', { jti: 'rt', grantId: 'g-1' } as never, 3600);

    await adapter('AccessToken').revokeByGrantId('g-1');
    expect([...rows.keys()]).toEqual([`RefreshToken:${sha256('rt')}`]);
  });

  describe('client assertion replay records', () => {
    it('are inserted, never overwritten: a second save of one assertion is refused', async () => {
      const { rows, adapter, InvalidClientAuth } = makeFixture();
      const replay = adapter('ReplayDetection');
      await replay.upsert('assertion-1', { jti: 'assertion-1', iss: 'https://chatgpt.com/oauth/client.json' } as never, 60);
      await expect(
        replay.upsert('assertion-1', { jti: 'assertion-1', iss: 'https://chatgpt.com/oauth/client.json' } as never, 60),
      ).rejects.toBeInstanceOf(InvalidClientAuth);
      expect(rows.size).toBe(1);
    });

    it('a long-expired record with the same id does not block a new one', async () => {
      const { rows, adapter } = makeFixture();
      const replay = adapter('ReplayDetection');
      await replay.upsert('assertion-1', { jti: 'assertion-1' } as never, 60);
      rows.get('ReplayDetection:assertion-1')!.expiresAt = new Date(Date.now() - 1000);
      await expect(replay.upsert('assertion-1', { jti: 'assertion-1' } as never, 60)).resolves.toBeUndefined();
    });

    it('other models still upsert', async () => {
      const { adapter } = makeFixture();
      const session = adapter('Session');
      await session.upsert('s-1', { jti: 's-1', uid: 'u' } as never, 600);
      await expect(session.upsert('s-1', { jti: 's-1', uid: 'u', accountId: 'a' } as never, 600)).resolves.toBeUndefined();
      await expect(session.find('s-1')).resolves.toMatchObject({ accountId: 'a' });
    });
  });
});
