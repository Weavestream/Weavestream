import { SetMetadata } from '@nestjs/common';

export const INTERACTIVE_ONLY_KEY = 'interactiveOnly';

/**
 * Marks a route (or a whole controller) as reachable only by a human session,
 * never by an API key.
 *
 * Use this on anything that manages *the identity itself* rather than the
 * business data it can see: credentials, MFA, sessions, API keys, and user
 * provisioning. The test is not "is this dangerous" but "does this let the
 * caller obtain or extend authority", because that is what turns a leaked key
 * from a revocable loss into an account takeover.
 *
 * Declaring it on the route rather than listing paths centrally is deliberate.
 * A central list is fail-open and drifts: a new account-management endpoint is
 * admitted by default, and nothing about adding it prompts anyone to go and
 * update a denylist in another file. The requirement travelling with the
 * handler cannot drift away from it.
 *
 * {@link ApiKeySurfaceGuard} still applies a path denylist for the known
 * `/auth` and `/me` trees as defence in depth, so forgetting this decorator on
 * those surfaces is not immediately fatal.
 */
export const InteractiveOnly = () => SetMetadata(INTERACTIVE_ONLY_KEY, true);
