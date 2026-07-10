import { AiToolBudgetService } from './ai-tool-budget.service.js';

function makeService(consume: jest.Mock) {
  const defineCommand = jest.fn();
  const redis = { client: { defineCommand, aiToolBudgetConsume: consume } };
  const env = {
    values: {
      AI_TOOL_BUDGET_USER_PER_HOUR: 100,
      AI_TOOL_BUDGET_CONVERSATION_PER_HOUR: 40,
    },
  };
   
  const svc = new AiToolBudgetService(redis as any, env as any);
  return { svc, defineCommand, consume };
}

describe('AiToolBudgetService', () => {
  it('registers exactly one two-key Lua command', () => {
    const { defineCommand } = makeService(jest.fn());
    expect(defineCommand).toHaveBeenCalledTimes(1);
    const [name, def] = defineCommand.mock.calls[0] as [
      string,
      { numberOfKeys: number; lua: string },
    ];
    expect(name).toBe('aiToolBudgetConsume');
    expect(def.numberOfKeys).toBe(2);
  });

  it('the script refuses BEFORE any mutation: both GETs and the denial return precede the first INCR', () => {
    const { defineCommand } = makeService(jest.fn());
    const lua = (defineCommand.mock.calls[0] as [string, { lua: string }])[1].lua;
    const firstIncr = lua.indexOf('INCR');
    const denialReturn = lua.indexOf('return {0');
    const lastGet = lua.lastIndexOf("'GET'");
    expect(firstIncr).toBeGreaterThan(-1);
    expect(denialReturn).toBeGreaterThan(-1);
    // Reads and the denial exit both come before any INCR — a denied
    // call can never charge either counter.
    expect(lastGet).toBeLessThan(firstIncr);
    expect(denialReturn).toBeLessThan(firstIncr);
    // TTLs are set inside the same script (no INCR-then-crash window).
    expect(lua.indexOf('EXPIRE')).toBeGreaterThan(firstIncr);
  });

  it('passes both keys and both limits and maps an allowed result', async () => {
    const consume = jest.fn(async () => [1, 0] as [number, number]);
    const { svc } = makeService(consume);
    const decision = await svc.consume('u-1', 'conv-1');
    expect(decision).toEqual({ allowed: true, retryAfterSeconds: 0 });
    expect(consume).toHaveBeenCalledWith(
      'ai_tool_budget:user:u-1',
      'ai_tool_budget:conv:conv-1',
      100,
      40,
      3600,
    );
  });

  it('maps a denial to retryAfterSeconds from the limiting window', async () => {
    const consume = jest.fn(async () => [0, 1234] as [number, number]);
    const { svc } = makeService(consume);
    const decision = await svc.consume('u-1', 'conv-1');
    expect(decision).toEqual({ allowed: false, retryAfterSeconds: 1234 });
  });

  it('fails CLOSED when Redis is unavailable', async () => {
    const consume = jest.fn(async () => {
      throw new Error('connection refused');
    });
    const { svc } = makeService(consume);
    const decision = await svc.consume('u-1', 'conv-1');
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
  });
});
