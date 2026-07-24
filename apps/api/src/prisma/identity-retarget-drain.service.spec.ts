import { Logger } from '@nestjs/common';
import { IdentityRetargetDrainService } from './identity-retarget-drain.service.js';
import type { PrismaService } from './prisma.service.js';

type RawCall = { kind: 'query' | 'execute'; text: string };

/**
 * Drives the drainer against an in-memory model of the helper table:
 * `pending` map rows, `drainPerRound` of which each UPDATE round can
 * move (simulating rows a concurrent transaction still holds when 0).
 */
function makeHarness(opts: {
  tableExists: boolean;
  pending?: number;
  drainPerRound?: number;
  failRounds?: boolean;
  vanishOnRound?: number;
}) {
  const state = {
    tableExists: opts.tableExists,
    pending: opts.pending ?? 0,
    drainPerRound: opts.drainPerRound ?? Number.POSITIVE_INFINITY,
    rounds: 0,
  };
  const calls: RawCall[] = [];
  const undefinedTable = Object.assign(new Error('relation does not exist'), {
    code: 'P2010',
    meta: { code: '42P01' },
  });
  const prisma = {
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      calls.push({ kind: 'query', text });
      if (text.includes('to_regclass')) {
        return [{ present: state.tableExists ? 'migration_0062_asset_identity_retarget' : null }];
      }
      if (text.includes('count(*)')) {
        if (!state.tableExists) throw undefinedTable;
        return [{ pending: BigInt(state.pending) }];
      }
      throw new Error(`unexpected query: ${text}`);
    }),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join(' ');
      calls.push({ kind: 'execute', text });
      if (text.includes('UPDATE')) {
        state.rounds += 1;
        if (opts.vanishOnRound && state.rounds >= opts.vanishOnRound) {
          state.tableExists = false;
        }
        if (!state.tableExists) throw undefinedTable;
        if (opts.failRounds) throw new Error('connection reset');
        state.pending = Number.isFinite(state.drainPerRound)
          ? Math.max(0, state.pending - state.drainPerRound)
          : 0;
        return 0;
      }
      if (text.includes('DELETE')) {
        if (!state.tableExists) throw undefinedTable;
        return 0;
      }
      if (text.includes('DROP TABLE')) {
        state.tableExists = false;
        return 0;
      }
      throw new Error(`unexpected statement: ${text}`);
    }),
  } as unknown as PrismaService;
  return { service: new IdentityRetargetDrainService(prisma), state, calls };
}

/** Flush microtasks and step fake time through `rounds` sleep gaps. */
async function advanceRounds(rounds: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(0);
  for (let i = 0; i < rounds; i += 1) {
    await jest.advanceTimersByTimeAsync(IdentityRetargetDrainService.ROUND_INTERVAL_MS);
  }
}

describe('IdentityRetargetDrainService', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('exits after one probe when the helper table does not exist', async () => {
    const { service, calls } = makeHarness({ tableExists: false });
    service.onApplicationBootstrap();
    await advanceRounds(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain('to_regclass');
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('warns, drains, and drops the table when bindings are pending', async () => {
    const { service, state, calls } = makeHarness({ tableExists: true, pending: 3 });
    service.onApplicationBootstrap();
    await advanceRounds(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('3 released duplicate asset(s)'));
    expect(state.tableExists).toBe(false);
    expect(calls.some((c) => c.text.includes('DROP TABLE'))).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('drained'));
  });

  it('keeps retrying across rounds while a holder pins bindings', async () => {
    const { service, state } = makeHarness({ tableExists: true, pending: 2, drainPerRound: 0 });
    service.onApplicationBootstrap();
    await advanceRounds(3);
    expect(state.rounds).toBeGreaterThanOrEqual(3);
    expect(state.tableExists).toBe(true);
    // Holder releases: rounds can now move rows.
    state.drainPerRound = 2;
    await advanceRounds(2);
    expect(state.tableExists).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('drained'));
    service.onModuleDestroy();
  });

  it('treats the table vanishing mid-drain as completion by a sibling drainer', async () => {
    const { service, state } = makeHarness({
      tableExists: true,
      pending: 2,
      drainPerRound: 0,
      vanishOnRound: 2,
    });
    service.onApplicationBootstrap();
    await advanceRounds(3);
    expect(state.rounds).toBe(2);
    expect(error).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('gives up after the consecutive-failure cap and keeps the table', async () => {
    const { service, state } = makeHarness({ tableExists: true, pending: 1, failRounds: true });
    service.onApplicationBootstrap();
    await advanceRounds(IdentityRetargetDrainService.MAX_CONSECUTIVE_FAILURES + 2);
    expect(state.rounds).toBe(IdentityRetargetDrainService.MAX_CONSECUTIVE_FAILURES);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Giving up'));
    expect(state.tableExists).toBe(true);
  });

  it('stops the loop on module destroy', async () => {
    const { service, state } = makeHarness({ tableExists: true, pending: 1, drainPerRound: 0 });
    service.onApplicationBootstrap();
    await advanceRounds(2);
    const roundsAtDestroy = state.rounds;
    service.onModuleDestroy();
    await advanceRounds(3);
    expect(state.rounds).toBe(roundsAtDestroy);
    expect(state.tableExists).toBe(true);
  });
});
