/**
 * Loads the workspace-root `.env` into `process.env` at the earliest
 * possible moment — MUST be imported before any module that reads env
 * (e.g. `EnvService` / `packages/shared/src/env.ts#loadEnv`).
 *
 * Behavior:
 *   - Looks for `.env` in the current working directory first (so an
 *     app-local override wins), then walks up the directory tree to
 *     the monorepo root.
 *   - Never overrides existing `process.env` values, so Docker Compose
 *     `environment:` injections and CI variables keep priority.
 *   - Silently no-ops if no `.env` is found — production containers
 *     get their env from Compose, not from a file.
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function findEnvFile(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envPath = findEnvFile(process.cwd());
if (envPath) {
  config({ path: envPath, override: false });
}
