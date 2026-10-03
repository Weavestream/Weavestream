/**
 * Type-only helpers for checking a service's `Serialized*` interface against
 * the shared wire contract in `@weavestream/shared`.
 *
 * Services keep `Date`-typed serializer interfaces because that is what they
 * build; the HTTP layer turns them into JSON. A contract spec asserts
 * `SameShape<WireJson<SerializedX>, SharedX>` so the two cannot drift
 * silently: a mismatch is a type error in `pnpm typecheck` and in Jest.
 */

/** The JSON form of `T`: what `JSON.stringify` puts on the wire. */
export type WireJson<T> = T extends Date
  ? string
  : T extends readonly (infer U)[]
    ? WireJson<U>[]
    : T extends object
      ? { [K in keyof T]: WireJson<T[K]> }
      : T;

/** `true` only when `A` and `B` are assignable to each other. */
export type SameShape<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;
