import { ConflictException } from '@nestjs/common';
import { CloudflareDriftSweepWorker } from './cloudflare-drift-sweep.processor.js';

const INT = '00000000-0000-4000-8000-000000000001';
const RUN = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';

function setup(opts: {
  sweep?: { checked: number; healed: number; errors: number; skipped: boolean };
  sync?: () => Promise<unknown>;
}) {
  const lists = {
    runDriftSweep: jest.fn(async () => opts.sweep ?? { checked: 1, healed: 0, errors: 0, skipped: false }),
    stampLastRun: jest.fn(async () => undefined),
  };
  const registrar = { sync: jest.fn(opts.sync ?? (async () => ({ enabled: true }))) };
  const worker = new CloudflareDriftSweepWorker({} as never, {} as never, lists as never, registrar as never);
  const handle = (name: string, data: object) =>
    (worker as unknown as { handle: (job: object) => Promise<unknown> }).handle({ name, id: 'j', data });
  return { lists, registrar, handle };
}

describe('CloudflareDriftSweepWorker "Last run" stamp', () => {
  it('stamps one success for a scheduled tick after both the lists and the domain sync', async () => {
    const { lists, registrar, handle } = setup({});
    await handle('scheduled', { integrationId: INT });
    expect(registrar.sync).toHaveBeenCalled();
    expect(lists.stampLastRun).toHaveBeenCalledTimes(1);
    expect(lists.stampLastRun).toHaveBeenCalledWith(INT, true);
  });

  it('stamps a failure when the list check had errors, even if the domain sync succeeded', async () => {
    const { lists, handle } = setup({ sweep: { checked: 2, healed: 0, errors: 1, skipped: false } });
    await handle('scheduled', { integrationId: INT });
    expect(lists.stampLastRun).toHaveBeenCalledWith(INT, false);
  });

  it('stamps a failure when the domain sync failed, without failing the job', async () => {
    const { lists, handle } = setup({ sync: async () => Promise.reject(new Error('403')) });
    await expect(handle('scheduled', { integrationId: INT })).resolves.toBeDefined();
    expect(lists.stampLastRun).toHaveBeenCalledWith(INT, false);
  });

  it('does not count a manual sync holding the lock as a failed tick', async () => {
    const { lists, handle } = setup({
      sync: async () => Promise.reject(new ConflictException('already running')),
    });
    await handle('scheduled', { integrationId: INT });
    expect(lists.stampLastRun).toHaveBeenCalledWith(INT, true);
  });

  it('does nothing more, and stamps nothing, for an integration that is not active', async () => {
    const { lists, registrar, handle } = setup({
      sweep: { checked: 0, healed: 0, errors: 0, skipped: true },
    });
    await handle('scheduled', { integrationId: INT });
    expect(registrar.sync).not.toHaveBeenCalled();
    expect(lists.stampLastRun).not.toHaveBeenCalled();
  });

  it('stamps a manual domain sync, success or failure', async () => {
    const ok = setup({});
    await ok.handle('manual', { integrationId: INT, triggeredBy: USER, runId: RUN });
    expect(ok.registrar.sync).toHaveBeenCalledWith(INT, USER, { runId: RUN });
    expect(ok.lists.runDriftSweep).not.toHaveBeenCalled();
    expect(ok.lists.stampLastRun).toHaveBeenCalledWith(INT, true);

    const bad = setup({ sync: async () => Promise.reject(new Error('403')) });
    await expect(bad.handle('manual', { integrationId: INT, runId: RUN })).rejects.toThrow('403');
    expect(bad.lists.stampLastRun).toHaveBeenCalledWith(INT, false);
  });

  it('leaves "Last run" alone when a manual sync is refused because one is already running', async () => {
    const { lists, handle } = setup({
      sync: async () => Promise.reject(new ConflictException('already running')),
    });
    await expect(handle('manual', { integrationId: INT, runId: RUN })).rejects.toThrow(/already running/);
    expect(lists.stampLastRun).not.toHaveBeenCalled();
  });
});
