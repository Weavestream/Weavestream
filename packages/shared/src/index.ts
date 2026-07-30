/**
 * Client-safe barrel for `@weavestream/shared`.
 *
 * Only exports modules that are isomorphic between browser and Node (Zod
 * schemas, role enums, and plain types). Anything that touches a Node-only
 * API — `node:async_hooks`, `Buffer`, `process.env` validation — lives in
 * `@weavestream/shared/server` and MUST NOT be re-exported from here, otherwise
 * bundling a React Client Component will pull Node built-ins into the
 * browser chunk and explode at runtime.
 *
 * Type-only re-exports (e.g. `TenantContext`) are safe here because they
 * are erased by TypeScript before any bundler sees them.
 */
export * from './roles.js';
export * from './password-strength.js';
export * from './safe-external-href.js';
export * from './mermaid-fence.js';
export * from './date-format.js';
export * from './ui-cookie.js';
export * from './schemas/index.js';
export * from './queues/index.js';
export * from './templates/index.js';
export * from './tiptap.js';
export * from './tiptap-doc.js';
export * from './tiptap-markdown.js';
export * from './markdown.js';
export * from './article-patch.js';
export * from './article-proposal.js';
export * from './ip-match.js';
export * from './tag-chips.js';
export * from './internal-token.js';
export * from './strip-nul.js';
export * from './image-limits.js';
export type { TenantContext } from './tenant-context.js';
