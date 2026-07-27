/**
 * Browser-only barrel for `@weavestream/shared/browser`.
 *
 * Everything here touches a DOM API — `document`, `navigator`,
 * `ClipboardItem`, `fetch` — and is compiled by `tsconfig.browser.json`,
 * the only project in this package with the DOM libs and without
 * `@types/node`. That split is what keeps the client-safe barrel (`.`)
 * importable from the Nest API without dragging DOM globals in, and
 * keeps these modules from quietly reaching for a Node API.
 *
 * Consumed by `apps/web` client components and by `apps/mobile`. Never
 * import this from a React Server Component or from `apps/api`.
 */
export * from './chat-stream.js';
export * from './client-id.js';
export * from './clipboard.js';
export * from './cookies.js';
export * from './csrf.js';
export * from './password-generator.js';
export * from './upload-client.js';
export * from './wordlist.js';
