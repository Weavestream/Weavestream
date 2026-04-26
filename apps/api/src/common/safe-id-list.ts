/**
 * Defense-in-depth guard for arrays of IDs that are about to be passed
 * to a Prisma `{ in: [...] }` clause. The values our services use here
 * are always either DB-derived (`.map(r => r.id)`) or controller params
 * already validated by `ParseUUIDPipe`, so the runtime check is a
 * tautology — but it makes scalar/object substitution structurally
 * impossible, which is what static analyzers want to see.
 *
 * Returns the same array (typed as `string[]`) if every element is a
 * string; throws otherwise.
 */
export function assertStringIdList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}: expected an array, got ${typeof value}`);
  }
  for (const v of value) {
    if (typeof v !== 'string') {
      throw new Error(`${label}: expected string ids, got ${typeof v}`);
    }
  }
  return value as string[];
}
