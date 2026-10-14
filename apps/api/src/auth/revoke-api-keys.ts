import { Prisma, type PrismaClient } from '@prisma/client';

type Client = Prisma.TransactionClient | PrismaClient;

export interface RevokedDelegatedAccess {
  apiKeys: number;
  mcpConnections: number;
}

/**
 * Revoke every live programmatic credential a user holds: API keys and remote
 * MCP connections. Every path that revokes one revokes the other — a password
 * change, "sign out everywhere", deactivation, MFA reset, re-invite and the
 * break-glass CLI commands all answer a suspected compromise, and a credential
 * that outlived them would be the one the user believes they just severed.
 *
 * A plain function rather than a service method so `UsersService`,
 * `AuthService`, `MeService` and the CLI can call it inside their own
 * transactions without a DI cycle (`AuthModule` already imports
 * `UsersModule`). This is the one place the revocation semantics live;
 * callers must not inline the queries.
 */
export async function revokeDelegatedAccessForUser(
  client: Client,
  userId: string,
): Promise<RevokedDelegatedAccess> {
  const apiKeys = await revokeApiKeysForUser(client, userId);
  const mcpConnections = await revokeMcpConnectionsForUser(client, userId);
  return { apiKeys, mcpConnections };
}

/**
 * Lock the user row for an edit that may change the authority API keys and
 * remote MCP connections inherit. Returns false when the user does not exist.
 *
 * Pairs with `lockUserForDelegatedMint`: an authority edit and a key or
 * connection mint on the same user serialize, so a credential is either
 * minted before the edit (and its revocation sees it) or after it commits
 * (and is minted against the new authority). Without the pair, a key minted
 * mid-edit could carry the old authority's intent past a promotion.
 *
 * Must run inside a transaction; the lock is held until it ends. Read the
 * user row after this call, not before — under READ COMMITTED the next
 * statement sees any edit that held the lock first.
 */
export async function lockUserForAuthorityChange(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE
  `);
  return rows.length > 0;
}

/**
 * Share-lock the user row while minting an API key or recording a remote MCP
 * connection. Concurrent mints do not block each other; an authority edit
 * (`lockUserForAuthorityChange`) waits for them, and they wait for it.
 */
export async function lockUserForDelegatedMint(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM users WHERE id = ${userId}::uuid FOR SHARE
  `);
}

async function revokeApiKeysForUser(client: Client, userId: string): Promise<number> {
  const { count } = await client.apiKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}

/**
 * `revokedAt` is what every `/mcp` request and token exchange checks, so it
 * alone ends the connection. The OAuth artifacts (codes, tokens, the grant)
 * are deleted as well so nothing usable-looking is left behind.
 */
async function revokeMcpConnectionsForUser(client: Client, userId: string): Promise<number> {
  const live = await client.mcpConnection.findMany({
    where: { userId, revokedAt: null },
    select: { grantId: true },
  });
  if (live.length === 0) return 0;
  const { count } = await client.mcpConnection.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await client.oAuthArtifact.deleteMany({
    where: { grantId: { in: live.map((c) => c.grantId) } },
  });
  return count;
}
