/**
 * Server-only barrel for `@weavestream/shared`.
 *
 * Import this from Node contexts (NestJS API, server components, scripts)
 * when you need runtime access to environment loading or the tenant-context
 * AsyncLocalStorage. Never import this from a React Client Component — it
 * pulls in `node:async_hooks` and `Buffer` and will fail to bundle.
 */
export * from './env.js';
export * from './tenant-context.js';
// Re-export the client-safe bits so server code can use a single import.
export * from './roles.js';
export * from './schemas/index.js';
