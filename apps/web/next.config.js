// Load the monorepo-root `.env` into process.env before Next.js resolves
// its own config. Next only auto-loads `.env*` from the package directory
// (apps/web), so without this step variables like `API_INTERNAL_URL` stay
// unset during `pnpm dev`, and the API rewrite below silently falls back
// to `http://api:4000` — the Docker Compose service hostname, which does
// not resolve on the host and surfaces as `getaddrinfo ENOTFOUND api`.
//
// Mirrors the behavior of `apps/api/src/load-env.ts`: walk up from cwd
// looking for the first `.env`, and never override values that are
// already set in the process (so Docker Compose `environment:` still
// wins in production).
const { existsSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

(function loadWorkspaceEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      require('dotenv').config({ path: candidate, override: false });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
})();

/** @type {import('next').NextConfig} */
const API_URL = process.env.API_INTERNAL_URL ?? 'http://api:4000';

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Hide the Next 16 dev-only "N" badge. Build/runtime errors still surface.
  devIndicators: false,
  // Rewrite barrel imports (`from '@tiptap/react'`) into deep named imports
  // so Turbopack only compiles the symbols we actually reference. In dev
  // this is the difference between shipping the entire Tiptap / dnd-kit /
  // ProseMirror graph to every route and shipping ~the page you're on.
  // Especially noticeable in Safari, whose dev-bundle parse time is several
  // times slower than V8.
  experimental: {
    optimizePackageImports: [
      '@tiptap/react',
      '@tiptap/starter-kit',
      '@tiptap/pm',
      '@tiptap/suggestion',
      '@tiptap/extension-bubble-menu',
      '@tiptap/extension-image',
      '@tiptap/extension-link',
      '@tiptap/extension-mention',
      '@tiptap/extension-placeholder',
      '@tiptap/extension-task-item',
      '@tiptap/extension-task-list',
      '@dnd-kit/core',
      '@dnd-kit/sortable',
      '@dnd-kit/utilities',
    ],
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `${API_URL}/api/:path*`,
      },
      {
        source: '/health',
        destination: `${API_URL}/health`,
      },
    ];
  },
};

module.exports = nextConfig;
