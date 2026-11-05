import type { DriverDescriptor } from '@weavestream/shared';

/**
 * Secret-bound config keys (`DriverDescriptor.secretBoundConfigKeys`): URLs
 * in `config` that the stored secret is sent to. A change of their origin
 * means the saved secret would go to a host it was not entered for, so the
 * change must come with a full new secret.
 */

/** Refusal text for a host change that carries no new secret. */
export const SECRET_BOUND_ORIGIN_MESSAGE = 'Enter the credentials again for the new host.';

/** The value at a dotted key (`auth.tokenUrl`), own properties only. */
function readDotted(config: Record<string, unknown>, key: string): unknown {
  let current: unknown = config;
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** The bound URL, or the descriptor default when the config leaves it out; undefined when there is neither. */
function boundValue(descriptor: Pick<DriverDescriptor, 'configFields'>, config: Record<string, unknown>, key: string): unknown {
  const value = readDotted(config, key);
  if (value !== undefined && value !== null && value !== '') return value;
  const fallback = descriptor.configFields.find((field) => field.key === key)?.default;
  return fallback !== undefined && fallback !== null && fallback !== '' ? fallback : undefined;
}

function originOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const origin = new URL(value).origin;
    return origin === 'null' ? null : origin;
  } catch {
    // Not a URL: the caller treats it as a change (fail closed).
    return null;
  }
}

/**
 * True when any secret-bound key moves to another host between `before`
 * and `after`:
 *   - absent on both sides: unchanged (e.g. `auth.tokenUrl` on a bearer definition);
 *   - present on one side only: changed;
 *   - present on both: the origins differ, or either value does not parse.
 * URL syntax itself is the driver's to validate.
 */
export function secretBoundOriginsChanged(
  descriptor: Pick<DriverDescriptor, 'configFields' | 'secretBoundConfigKeys'>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  for (const key of descriptor.secretBoundConfigKeys ?? []) {
    const previous = boundValue(descriptor, before, key);
    const next = boundValue(descriptor, after, key);
    if (previous === undefined && next === undefined) continue;
    if (previous === undefined || next === undefined) return true;
    const previousOrigin = originOf(previous);
    const nextOrigin = originOf(next);
    if (previousOrigin === null || nextOrigin === null || previousOrigin !== nextOrigin) return true;
  }
  return false;
}
