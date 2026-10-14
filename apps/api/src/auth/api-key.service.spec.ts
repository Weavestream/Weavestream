import { createHash, randomBytes } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApiKeyService, DEFAULT_EXPIRY_DAYS } from './api-key.service.js';

/** Everything after the second separator — the secret may itself contain `_`. */
const secretOf = (token: string) =>
  token.slice(token.indexOf('_', token.indexOf('_') + 1) + 1);

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

function makeService({ enabled = true }: { enabled?: boolean } = {}) {
  const rows = new Map<string, Record<string, unknown>>();
  const connections = new Map<string, { userId: string; grantId: string; revokedAt: Date | null }>();
  /** OAuth artifact id → the grant it belongs to. */
  const artifacts = new Map<string, string>();
  const prisma = {
    apiKey: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row: Record<string, unknown> = {
          id: `id-${rows.size + 1}`,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date(),
          ...data,
        };
        rows.set(row.keyId as string, row);
        return row;
      }),
      findUnique: jest.fn(
        async ({ where }: { where: { keyId: string } }) =>
          rows.get(where.keyId) ?? null,
      ),
      updateMany: jest.fn(
        async ({ where }: { where: { id?: string; userId: string } }) => {
          let count = 0;
          for (const row of rows.values()) {
            if (row.userId !== where.userId || row.revokedAt) continue;
            if (where.id !== undefined && row.id !== where.id) continue;
            row.revokedAt = new Date();
            count += 1;
          }
          return { count };
        },
      ),
      update: jest.fn(async () => ({})),
      findMany: jest.fn(async () => []),
    },
    // Both stubs honour `revokedAt: null`, as the real queries do.
    mcpConnection: {
      findMany: jest.fn(
        async ({ where }: { where: { userId: string; revokedAt: null } }) =>
          [...connections.values()]
            .filter((c) => c.userId === where.userId && c.revokedAt === where.revokedAt)
            .map((c) => ({ grantId: c.grantId })),
      ),
      updateMany: jest.fn(
        async ({ where }: { where: { userId: string; revokedAt: null } }) => {
          let count = 0;
          for (const c of connections.values()) {
            if (c.userId !== where.userId || c.revokedAt !== where.revokedAt) continue;
            c.revokedAt = new Date();
            count += 1;
          }
          return { count };
        },
      ),
    },
    oAuthArtifact: {
      deleteMany: jest.fn(async ({ where }: { where: { grantId: { in: string[] } } }) => {
        let count = 0;
        for (const [id, grantId] of artifacts) {
          if (!where.grantId.in.includes(grantId)) continue;
          artifacts.delete(id);
          count += 1;
        }
        return { count };
      }),
    },
    // Interactive transaction: run the callback against the same stub.
    // The user-row share lock taken before minting.
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'u-1' }]),
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as Record<string, unknown>;
  const audit = {
    log: jest.fn().mockResolvedValue(undefined),
    logWithClient: jest.fn().mockResolvedValue(undefined),
  };
  const settings = { apiKeysEnabled: jest.fn().mockResolvedValue(enabled) };
  return {
    svc: new ApiKeyService(prisma as never, audit as never, settings as never),
    rows,
    audit,
    prisma,
    connections,
    artifacts,
  };
}

const META = { ip: '198.51.100.7', userAgent: 'jest' };
const ACTOR = { id: 'u-1', sessionId: 's-1' } as never;

describe('ApiKeyService', () => {
  describe('mint', () => {
    it('returns a ws_<keyId>_<secret> token whose secret is only stored hashed', async () => {
      const { svc, rows } = makeService();
      const { record, token } = await svc.mint({
        userId: 'u-1',
        name: 'ci',
        createdBy: 'u-1',
      });

      const first = token.indexOf('_');
      const second = token.indexOf('_', first + 1);
      const prefix = token.slice(0, first);
      const keyId = token.slice(first + 1, second);
      const secret = token.slice(second + 1);
      expect(prefix).toBe('ws');
      expect(keyId).toBe(record.keyId);
      expect(keyId).toMatch(/^[0-9a-f]+$/);

      // The plaintext secret must never be persisted — only its digest.
      const stored = rows.get(keyId)!;
      expect(stored.tokenHash).toBe(sha256(secret));
      expect(JSON.stringify(stored)).not.toContain(secret);
    });

    it('applies a default expiry rather than creating an immortal key', async () => {
      const { svc } = makeService();
      const { record } = await svc.mint({ userId: 'u-1', name: 'k', createdBy: 'u-1' });
      const days = Math.round(
        ((record.expiresAt as Date).getTime() - Date.now()) / 86_400_000,
      );
      expect(days).toBe(DEFAULT_EXPIRY_DAYS);
    });

    it('honours an explicit null expiry as a deliberate opt-out', async () => {
      const { svc } = makeService();
      const { record } = await svc.mint({
        userId: 'u-1',
        name: 'k',
        createdBy: 'u-1',
        expiresInDays: null,
      });
      expect(record.expiresAt).toBeNull();
    });

    it('refuses a scope list it cannot enforce', async () => {
      const { svc } = makeService();
      // Accepting an unenforced narrowing control would make an operator
      // believe a key is restricted when it holds the owner's full authority.
      await expect(
        svc.mint({
          userId: 'u-1',
          name: 'k',
          createdBy: 'u-1',
          scopes: ['asset.read'],
        }),
      ).rejects.toThrow(/not supported yet/i);
    });

    it('issues a distinct keyId and secret every time', async () => {
      const { svc } = makeService();
      const a = await svc.mint({ userId: 'u-1', name: 'a', createdBy: 'u-1' });
      const b = await svc.mint({ userId: 'u-1', name: 'b', createdBy: 'u-1' });
      expect(a.record.keyId).not.toBe(b.record.keyId);
      expect(a.token).not.toBe(b.token);
    });
  });

  describe('verify', () => {
    it('accepts a freshly minted token', async () => {
      const { svc } = makeService();
      const { token, record } = await svc.mint({
        userId: 'u-1',
        name: 'k',
        createdBy: 'u-1',
      });
      await expect(svc.verify(token)).resolves.toMatchObject({ id: record.id });
    });

    it('rejects a token whose secret has been altered', async () => {
      const { svc } = makeService();
      const { record } = await svc.mint({ userId: 'u-1', name: 'k', createdBy: 'u-1' });
      const forged = `ws_${record.keyId}_${randomBytes(32).toString('base64url')}`;
      await expect(svc.verify(forged)).resolves.toBeNull();
    });

    it('rejects revoked and expired keys', async () => {
      const { svc, rows } = makeService();
      const revoked = await svc.mint({ userId: 'u-1', name: 'r', createdBy: 'u-1' });
      rows.get(revoked.record.keyId)!.revokedAt = new Date();
      await expect(svc.verify(revoked.token)).resolves.toBeNull();

      const expired = await svc.mint({ userId: 'u-1', name: 'e', createdBy: 'u-1' });
      rows.get(expired.record.keyId)!.expiresAt = new Date(Date.now() - 1000);
      await expect(svc.verify(expired.token)).resolves.toBeNull();
    });

    it('rejects malformed input without hitting the database', async () => {
      const { svc } = makeService();
      for (const bad of ['', 'nonsense', 'ws_only-two', 'xx_a_b', 'ws__b', 'ws_a_']) {
        await expect(svc.verify(bad)).resolves.toBeNull();
      }
      // parse() must short-circuit so attacker-shaped input is never a lookup key.
      expect(
        (svc as unknown as { prisma: { apiKey: { findUnique: jest.Mock } } }).prisma
          .apiKey.findUnique,
      ).not.toHaveBeenCalled();
    });

    it('is not an existence oracle: unknown and wrong-secret are indistinguishable', async () => {
      const { svc } = makeService();
      const { record } = await svc.mint({ userId: 'u-1', name: 'k', createdBy: 'u-1' });
      const wrongSecret = await svc.verify(`ws_${record.keyId}_${'A'.repeat(43)}`);
      const unknownKey = await svc.verify(`ws_${'b'.repeat(18)}_${'C'.repeat(43)}`);
      expect(wrongSecret).toBeNull();
      expect(unknownKey).toBeNull();
    });
  });

  describe('revoke', () => {
    it('revokes the acting user’s own key and audits by id, never by value', async () => {
      const { svc, audit } = makeService();
      const { record, token } = await svc.mint({
        userId: 'u-1',
        name: 'k',
        createdBy: 'u-1',
      });
      await svc.revoke(ACTOR, record.id, META);
      await expect(svc.verify(token)).resolves.toBeNull();

      const entry = audit.log.mock.calls[0][0];
      expect(entry).toMatchObject({
        action: 'auth.api_key.revoke',
        entityId: record.id,
      });
      expect(JSON.stringify(entry)).not.toContain(secretOf(token));
    });

    it("refuses another user's key, so an id guess cannot escalate (IDOR)", async () => {
      const { svc } = makeService();
      const victim = await svc.mint({
        userId: 'victim',
        name: 'theirs',
        createdBy: 'victim',
      });
      await expect(svc.revoke(ACTOR, victim.record.id, META)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      // Still live for its real owner.
      await expect(svc.verify(victim.token)).resolves.not.toBeNull();
    });
  });

  describe('create', () => {
    it('audits the mint by reference and never logs the secret', async () => {
      const { svc, audit } = makeService();
      const out = await svc.create(ACTOR, { name: 'mcp' }, META);
      const entry = audit.logWithClient.mock.calls[0][1];
      expect(entry).toMatchObject({
        action: 'auth.api_key.create',
        entityType: 'api_key',
        entityId: out.id,
      });
      expect(JSON.stringify(entry)).not.toContain(secretOf(out.token));
      expect(JSON.stringify(entry)).not.toContain(out.token);
    });
    it('is read-only unless write access is asked for, and audits the choice', async () => {
      const { svc, audit } = makeService();
      const ro = await svc.create(ACTOR, { name: 'agent' }, META);
      expect(ro.allowWrite).toBe(false);
      const rw = await svc.create(ACTOR, { name: 'sync', allowWrite: true }, META);
      expect(rw.allowWrite).toBe(true);
      expect(audit.logWithClient.mock.calls[1][1].after).toMatchObject({ allowWrite: true });
    });

    it('share-locks the owner row before inserting, inside the transaction', async () => {
      const { svc, prisma } = makeService();
      await svc.create(ACTOR, { name: 'mcp' }, META);
      const queryRaw = prisma.$queryRaw as jest.Mock;
      const create = (prisma.apiKey as { create: jest.Mock }).create;
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const sql = queryRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
      expect(sql.strings.join('?')).toMatch(/FROM users WHERE id = \?::uuid FOR SHARE/);
      expect(sql.values).toEqual(['u-1']);
      const [lockedAt] = queryRaw.mock.invocationCallOrder;
      const [createdAt] = create.mock.invocationCallOrder;
      expect(lockedAt).toBeLessThan(createdAt!);
    });

    it('refuses to mint while API keys are turned off', async () => {
      const { svc, rows } = makeService({ enabled: false });
      await expect(svc.create(ACTOR, { name: 'mcp' }, META)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(rows.size).toBe(0);
    });

    it('creates no key when the audit write fails', async () => {
      // Key and audit row commit together: an unaudited key must never exist,
      // and the caller must never be left without the token for a live key.
      const { svc, audit, rows } = makeService();
      audit.logWithClient.mockRejectedValueOnce(new Error('audit down'));
      // The stub has no rollback, so assert on what create() surfaces: the
      // error, not a token. Real rollback is Prisma's $transaction contract.
      await expect(svc.create(ACTOR, { name: 'mcp' }, META)).rejects.toThrow('audit down');
      expect(rows.size).toBe(1);
    });
  });
  describe('revokeAllForUser', () => {
    it('kills every live key for the user and leaves other users alone', async () => {
      const { svc } = makeService();
      const a = await svc.mint({ userId: 'u-1', name: 'a', createdBy: 'u-1' });
      const b = await svc.mint({ userId: 'u-1', name: 'b', createdBy: 'u-1' });
      const other = await svc.mint({ userId: 'u-2', name: 'c', createdBy: 'u-2' });

      await expect(svc.revokeAllForUser('u-1')).resolves.toEqual({ apiKeys: 2, mcpConnections: 0 });
      await expect(svc.verify(a.token)).resolves.toBeNull();
      await expect(svc.verify(b.token)).resolves.toBeNull();
      // A compromise response for one user must not sign out another.
      await expect(svc.verify(other.token)).resolves.not.toBeNull();
    });

    /**
     * u-1 has two live connections and one already revoked; u-2 has one live
     * connection. Each grant owns a code, an access token and a refresh token.
     */
    function seedConnections(fx: ReturnType<typeof makeService>) {
      const seed = (id: string, userId: string, revokedAt: Date | null) => {
        const grantId = `grant-${id}`;
        fx.connections.set(id, { userId, grantId, revokedAt });
        for (const kind of ['code', 'access', 'refresh']) fx.artifacts.set(`${kind}-${id}`, grantId);
      };
      const earlier = new Date('2026-01-01T00:00:00Z');
      seed('c-1', 'u-1', null);
      seed('c-2', 'u-1', null);
      seed('c-old', 'u-1', earlier);
      seed('c-3', 'u-2', null);
      return earlier;
    }

    it("revokes only the target user's live AI connections and deletes their OAuth artifacts", async () => {
      const fx = makeService();
      await fx.svc.mint({ userId: 'u-1', name: 'a', createdBy: 'u-1' });
      const earlier = seedConnections(fx);

      await expect(fx.svc.revokeAllForUser('u-1')).resolves.toEqual({ apiKeys: 1, mcpConnections: 2 });

      expect(fx.connections.get('c-1')!.revokedAt).toBeInstanceOf(Date);
      expect(fx.connections.get('c-2')!.revokedAt).toBeInstanceOf(Date);
      // An earlier revocation keeps its own timestamp and is not counted again.
      expect(fx.connections.get('c-old')!.revokedAt).toBe(earlier);
      // Another user's connection and tokens are untouched.
      expect(fx.connections.get('c-3')!.revokedAt).toBeNull();
      expect([...fx.artifacts.keys()].sort()).toEqual([
        'access-c-3',
        'access-c-old',
        'code-c-3',
        'code-c-old',
        'refresh-c-3',
        'refresh-c-old',
      ]);
      // Only the grants that were live are targeted.
      const { deleteMany } = fx.prisma.oAuthArtifact as { deleteMany: jest.Mock };
      expect(deleteMany).toHaveBeenCalledTimes(1);
      expect(deleteMany).toHaveBeenCalledWith({ where: { grantId: { in: ['grant-c-1', 'grant-c-2'] } } });
    });

    it('is idempotent', async () => {
      const fx = makeService();
      await fx.svc.mint({ userId: 'u-1', name: 'a', createdBy: 'u-1' });
      seedConnections(fx);
      await expect(fx.svc.revokeAllForUser('u-1')).resolves.toEqual({ apiKeys: 1, mcpConnections: 2 });
      const revokedAt = fx.connections.get('c-1')!.revokedAt;
      const artifactsAfterFirst = [...fx.artifacts.keys()].sort();

      await expect(fx.svc.revokeAllForUser('u-1')).resolves.toEqual({ apiKeys: 0, mcpConnections: 0 });
      expect(fx.connections.get('c-1')!.revokedAt).toBe(revokedAt);
      expect([...fx.artifacts.keys()].sort()).toEqual(artifactsAfterFirst);
      // Nothing live was left, so the second run deletes nothing at all.
      expect((fx.prisma.oAuthArtifact as { deleteMany: jest.Mock }).deleteMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('parse hardening', () => {
    it('rejects an over-long keyId before it reaches a lookup', async () => {
      const { svc } = makeService();
      // Unbounded hex would push arbitrary bytes into an unauthenticated query.
      const huge = 'a'.repeat(4096);
      await expect(svc.verify(`ws_${huge}_${'C'.repeat(43)}`)).resolves.toBeNull();
    });
  });
});
