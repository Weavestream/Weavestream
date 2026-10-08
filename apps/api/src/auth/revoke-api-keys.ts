import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Revoke every live API key a user holds. Returns the number revoked.
 *
 * A plain function rather than an `ApiKeyService` method so `UsersService`,
 * `AuthService` and the CLI can call it inside their own transactions without
 * a DI cycle (`AuthModule` already imports `UsersModule`). This is the one
 * place the revocation semantics live; callers must not inline the query.
 */
export async function revokeApiKeysForUser(
  client: Prisma.TransactionClient | PrismaClient,
  userId: string,
): Promise<number> {
  const { count } = await client.apiKey.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count;
}
