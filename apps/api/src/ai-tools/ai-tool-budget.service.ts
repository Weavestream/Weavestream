import { Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../redis/redis.service.js';
import { EnvService } from '../config/env.service.js';

export interface BudgetDecision {
  allowed: boolean;
  /** Seconds until the limiting window resets; 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Cross-turn budget for AI read-tool executions (WS-030): fixed-window
 * Redis counters per user and per conversation, independent of the
 * per-request HTTP throttle (one chat request can trigger several
 * internal tool/model operations).
 *
 * Atomicity: ONE Lua script reads both counters, refuses BEFORE any
 * mutation when either limit is hit (so a denied call never charges
 * the other bucket), and otherwise increments both and sets both TTLs
 * in the same script — no INCR-then-EXPIRE crash window that could
 * leave an unexpiring counter.
 *
 * Failure policy: Redis unavailability fails CLOSED for tool execution
 * (reads are an enhancement; the chat answer still streams) with a
 * WARN log.
 */
const WINDOW_SECONDS = 3600;

const CONSUME_LUA = `
local userCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local convCount = tonumber(redis.call('GET', KEYS[2]) or '0')
local userLimit = tonumber(ARGV[1])
local convLimit = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
if userCount >= userLimit or convCount >= convLimit then
  local retry = 0
  if userCount >= userLimit then
    local ttl = redis.call('TTL', KEYS[1])
    if ttl > retry then retry = ttl end
  end
  if convCount >= convLimit then
    local ttl = redis.call('TTL', KEYS[2])
    if ttl > retry then retry = ttl end
  end
  if retry <= 0 then retry = window end
  return {0, retry}
end
local u = redis.call('INCR', KEYS[1])
if u == 1 then redis.call('EXPIRE', KEYS[1], window) end
local c = redis.call('INCR', KEYS[2])
if c == 1 then redis.call('EXPIRE', KEYS[2], window) end
return {1, 0}
`;

/** `defineCommand` augments the client at runtime; type the addition. */
type RedisWithBudget = Redis & {
  aiToolBudgetConsume(
    userKey: string,
    conversationKey: string,
    userLimit: number,
    conversationLimit: number,
    windowSeconds: number,
  ): Promise<[number, number]>;
};

@Injectable()
export class AiToolBudgetService {
  private readonly logger = new Logger(AiToolBudgetService.name);
  private readonly client: RedisWithBudget;

  constructor(
    redis: RedisService,
    private readonly env: EnvService,
  ) {
    redis.client.defineCommand('aiToolBudgetConsume', {
      numberOfKeys: 2,
      lua: CONSUME_LUA,
    });
    this.client = redis.client as RedisWithBudget;
  }

  async consume(userId: string, conversationId: string): Promise<BudgetDecision> {
    try {
      const [allowed, retry] = await this.client.aiToolBudgetConsume(
        `ai_tool_budget:user:${userId}`,
        `ai_tool_budget:conv:${conversationId}`,
        this.env.values.AI_TOOL_BUDGET_USER_PER_HOUR,
        this.env.values.AI_TOOL_BUDGET_CONVERSATION_PER_HOUR,
        WINDOW_SECONDS,
      );
      return { allowed: allowed === 1, retryAfterSeconds: retry };
    } catch (err) {
      // Fail closed: without a working budget we don't run tools, but
      // we also don't fail the chat turn — the model answers untooled.
      this.logger.warn(
        `AI tool budget check failed, refusing execution: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { allowed: false, retryAfterSeconds: 60 };
    }
  }
}
