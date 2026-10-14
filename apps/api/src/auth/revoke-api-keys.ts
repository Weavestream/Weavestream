import type { Prisma, PrismaClient } from '@prisma/client';

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
