import type { BackupConfig, BackupRunDto } from '@weavestream/shared';
import { serverApiFetch } from './core';

// ───────────────────────────────────────────────────────────────────
// Backups admin (`/admin/backups`)
//
// Server-rendered first paint loads schedules and recent runs. The
// client component then refreshes via `apiFetch` after mutations and
// while polling a "Run now" attempt to terminal status.
// ───────────────────────────────────────────────────────────────────

export async function listBackupConfigs(): Promise<BackupConfig[]> {
  const res = await serverApiFetch<BackupConfig[]>('/backups/configs');
  if (!res.ok || !res.data) return [];
  return res.data;
}

export async function listBackupRuns(): Promise<BackupRunDto[]> {
  const res = await serverApiFetch<BackupRunDto[]>('/backups/runs?limit=50');
  if (!res.ok || !res.data) return [];
  return res.data;
}
