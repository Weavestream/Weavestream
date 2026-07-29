/**
 * Re-export shim — the classification helper moved to
 * `@weavestream/shared` in Phase 5b so the mobile Ask proposal cards
 * run the same create-vs-edit decision (same pattern as the
 * `chat-stream` promotion). Import from `@weavestream/shared` in new
 * code; this path stays for existing imports.
 */
export { isRewriteTargetHallucinated } from '@weavestream/shared';
