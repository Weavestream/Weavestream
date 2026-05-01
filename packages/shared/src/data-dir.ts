/**
 * Resolve a storage directory env value (e.g. `FILE_STORAGE_DIR`,
 * `BACKUP_STORAGE_DIR`) to an absolute filesystem path.
 *
 * Why this exists: relative defaults like `./data/files` resolve via
 * `path.resolve` against `process.cwd()`. Under `pnpm dev` each app is
 * launched from its own package directory, so the api ends up looking
 * at `apps/api/data/files` while the worker writes to
 * `apps/worker/data/files` — they silently diverge and exports
 * surface as "expired and been deleted" because the api can't see the
 * file the worker wrote.
 *
 * In production (Docker Compose) the values are absolute and short-
 * circuit straight back out, so the container env keeps the contract
 * spelled out in `compose.yml`.
 *
 * Anchor strategy:
 *   1. If the value is already absolute, return it verbatim.
 *   2. Otherwise resolve it against the monorepo root, located by
 *      walking up from `process.cwd()` looking for either
 *      `pnpm-workspace.yaml` or a `package.json` whose `name`
 *      matches the workspace root (`weavestream`).
 *   3. Fall back to `process.cwd()` if no marker is found — keeps the
 *      function safe to call from one-off scripts that live outside
 *      the monorepo (e.g. unit tests with a synthetic cwd).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const WORKSPACE_MARKER = 'pnpm-workspace.yaml';
const WORKSPACE_PACKAGE_NAME = 'weavestream';
const MAX_WALK_DEPTH = 8;

let cachedWorkspaceRoot: string | null | undefined;

function findWorkspaceRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    if (existsSync(resolve(dir, WORKSPACE_MARKER))) return dir;
    const pkgPath = resolve(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: string;
        };
        if (pkg.name === WORKSPACE_PACKAGE_NAME) return dir;
      } catch {
        // Malformed package.json — keep walking.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function workspaceRoot(): string | null {
  if (cachedWorkspaceRoot !== undefined) return cachedWorkspaceRoot;
  cachedWorkspaceRoot = findWorkspaceRoot(process.cwd());
  return cachedWorkspaceRoot;
}

export function resolveDataDir(value: string): string {
  if (isAbsolute(value)) return value;
  const root = workspaceRoot() ?? process.cwd();
  return resolve(root, value);
}
