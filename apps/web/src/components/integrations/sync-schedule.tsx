'use client';

import { Select } from '../ui';

/**
 * Sync-schedule interval picker shared by every integration surface
 * (create dialog + credentials tab, all drivers).
 *
 * Operators pick a human interval; the wire/storage format stays the
 * 5-field UTC cron the scheduler already consumes, so the API contract
 * and existing rows are untouched. A stored cron that matches no preset
 * (hand-entered before this picker existed, or set via the API) is
 * surfaced as a "Custom" option holding the exact value — it is never
 * silently rewritten.
 */
export interface SyncSchedulePreset {
  /** Exact cron persisted on `Integration.syncCron`. */
  cron: string;
  label: string;
  /** Interval length, for ordering in tables. */
  minutes: number;
}

export const SYNC_SCHEDULE_PRESETS: SyncSchedulePreset[] = [
  { cron: '*/5 * * * *', label: 'Every 5 minutes', minutes: 5 },
  { cron: '*/10 * * * *', label: 'Every 10 minutes', minutes: 10 },
  { cron: '*/15 * * * *', label: 'Every 15 minutes', minutes: 15 },
  { cron: '*/30 * * * *', label: 'Every 30 minutes', minutes: 30 },
  { cron: '0 * * * *', label: 'Every hour', minutes: 60 },
  { cron: '0 */2 * * *', label: 'Every 2 hours', minutes: 120 },
  { cron: '0 */3 * * *', label: 'Every 3 hours', minutes: 180 },
  { cron: '0 */4 * * *', label: 'Every 4 hours', minutes: 240 },
  { cron: '0 */6 * * *', label: 'Every 6 hours', minutes: 360 },
  { cron: '0 */8 * * *', label: 'Every 8 hours', minutes: 480 },
  { cron: '0 */12 * * *', label: 'Every 12 hours', minutes: 720 },
  { cron: '0 0 * * *', label: 'Every 24 hours (00:00 UTC)', minutes: 1440 },
];

function findPreset(cron: string): SyncSchedulePreset | undefined {
  const trimmed = cron.trim();
  return SYNC_SCHEDULE_PRESETS.find((p) => p.cron === trimmed);
}

/** Preset label for a stored cron, or `null` when it matches no preset. */
export function describeSyncCron(cron: string | null | undefined): string | null {
  if (!cron) return null;
  return findPreset(cron)?.label ?? null;
}

/**
 * Table sort key: preset interval in minutes; custom crons sort after
 * every preset (their true cadence is unknown without a parser).
 */
export function syncCronSortMinutes(cron: string | null | undefined): number | null {
  if (!cron) return null;
  return findPreset(cron)?.minutes ?? Number.MAX_SAFE_INTEGER;
}

export function syncScheduleLabel(kind: 'security' | 'pull'): string {
  return kind === 'security' ? 'Drift sweep schedule' : 'Sync schedule';
}

/**
 * Field help matching the current selection. Keeps the exact cron
 * visible once an interval is chosen so operators can correlate with
 * scheduler logs, without asking anyone to write cron themselves.
 */
export function syncScheduleHelp(kind: 'security' | 'pull', value: string): string {
  const trimmed = value.trim();
  const base =
    trimmed === ''
      ? "Inherits the global default schedule; administrators can set that default to 'off' to disable scheduled runs."
      : `Runs on UTC cron ${trimmed}. Intervals of an hour or more fire at fixed UTC times.`;
  return kind === 'security'
    ? `Each tick checks Cloudflare-registered lists and auto-heals drift. ${base}`
    : base;
}

export function SyncScheduleSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  /** Stored cron, or `''` to inherit the global default. */
  value: string;
  onChange: (next: string) => void;
}) {
  const trimmed = value.trim();
  const isCustom = trimmed !== '' && !findPreset(trimmed);
  return (
    <Select id={id} value={trimmed} onChange={(e) => onChange(e.target.value)}>
      <option value="">Inherit global default</option>
      {SYNC_SCHEDULE_PRESETS.map((p) => (
        <option key={p.cron} value={p.cron}>
          {p.label}
        </option>
      ))}
      {isCustom && (
        <option value={trimmed}>{`Custom — ${trimmed} (UTC cron)`}</option>
      )}
    </Select>
  );
}
