/** @jest-environment jsdom */
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  SYNC_SCHEDULE_PRESETS,
  SyncScheduleSelect,
  describeSyncCron,
  syncCronSortMinutes,
  syncScheduleHelp,
} from './sync-schedule';

describe('sync schedule helpers', () => {
  it('describes every preset cron and rejects unknown expressions', () => {
    for (const preset of SYNC_SCHEDULE_PRESETS) {
      expect(describeSyncCron(preset.cron)).toBe(preset.label);
    }
    expect(describeSyncCron('  */15 * * * *  ')).toBe('Every 15 minutes');
    expect(describeSyncCron('7 3 * * 2')).toBeNull();
    expect(describeSyncCron(null)).toBeNull();
    expect(describeSyncCron(undefined)).toBeNull();
  });

  it('sorts presets by interval with custom crons last and missing schedules as null', () => {
    const five = syncCronSortMinutes('*/5 * * * *');
    const daily = syncCronSortMinutes('0 0 * * *');
    const custom = syncCronSortMinutes('7 3 * * 2');
    expect(five).toBe(5);
    expect(daily).toBe(1440);
    expect(custom).toBeGreaterThan(daily as number);
    expect(syncCronSortMinutes(null)).toBeNull();
  });

  it('keeps preset intervals strictly ascending so the picker reads top-down', () => {
    const minutes = SYNC_SCHEDULE_PRESETS.map((p) => p.minutes);
    expect([...minutes].sort((a, b) => a - b)).toEqual(minutes);
    expect(new Set(SYNC_SCHEDULE_PRESETS.map((p) => p.cron)).size).toBe(
      SYNC_SCHEDULE_PRESETS.length,
    );
  });

  it('explains inheritance when empty and shows the exact cron once chosen', () => {
    expect(syncScheduleHelp('pull', '')).toMatch(/inherits the global default/i);
    expect(syncScheduleHelp('pull', '')).toMatch(/'off'/);
    expect(syncScheduleHelp('pull', '0 */6 * * *')).toContain('0 */6 * * *');
    expect(syncScheduleHelp('security', '')).toMatch(/drift/i);
  });
});

describe('SyncScheduleSelect', () => {
  it('offers inherit + every preset and reports the picked cron', () => {
    const onChange = jest.fn();
    render(<SyncScheduleSelect id="s" value="" onChange={onChange} />);
    const select = screen.getByRole('combobox');
    expect(select).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Inherit global default' })).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(SYNC_SCHEDULE_PRESETS.length + 1);

    fireEvent.change(select, { target: { value: '*/15 * * * *' } });
    expect(onChange).toHaveBeenCalledWith('*/15 * * * *');
  });

  it('preserves a non-preset cron as an explicit Custom option', () => {
    render(<SyncScheduleSelect id="s" value="7 3 * * 2" onChange={jest.fn()} />);
    expect(screen.getByRole('combobox')).toHaveValue('7 3 * * 2');
    expect(
      screen.getByRole('option', { name: 'Custom — 7 3 * * 2 (UTC cron)' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(SYNC_SCHEDULE_PRESETS.length + 2);
  });
});
