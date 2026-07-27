'use client';

/**
 * Re-export shim. The SSE chat client moved to
 * `packages/shared/src/browser/chat-stream.ts` in mobile Phase 3 so the
 * Ask anything panel can share it (2c precedent: web keeps the old
 * import path alive). New code should import from
 * `@weavestream/shared/browser` directly.
 */
export {
  streamChatMessage,
  type ChatStreamErrorOrigin,
  type ChatStreamHandlers,
  type ChatStreamMeta,
  type ChatToolActivity,
} from '@weavestream/shared/browser';
