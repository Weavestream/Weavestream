/**
 * Loads the workspace-root `.env` into `process.env` at the earliest
 * possible moment — mirrors the same helper in `apps/api/src/load-env.ts`.
 * MUST be imported before any module that reads env.
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
