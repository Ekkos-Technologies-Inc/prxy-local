/**
 * cost-guard — enforce per-request, per-day, and per-month USD budgets.
 *
 * Pre: estimate request cost from input tokens × pricing. If any limit would
 * be breached, short-circuit with a 429-shaped error response.
 *
 * Post: increment the actual spend counters from the response usage.
 */

import { calculateActualCost, estimateRequestCost } from '../lib/cost.js';
import { errorResponse } from '../lib/errors.js';
import type {
  Module,
  RequestContext,
  ResponseContext,
  StorageAdapter,
} from '../types/sdk.js';

export interface CostGuardConfig {
  /** Hard cap per single request in USD. */
  perRequest?: number;
  /** Per-user daily cap in USD. */
  perDay?: number;
  /** Per-user monthly cap in USD. */
  perMonth?: number;
  /** Override key prefix. Default 'cost'. */
  keyPrefix?: string;
}

export function costGuard(config: CostGuardConfig = {}): Module {
  const prefix = config.keyPrefix ?? 'cost';

  return {
    name: 'cost-guard',
    version: '1.0.0',

    async pre(ctx) {
      const estimated = estimateRequestCost(ctx.request);
      ctx.metadata.set('cost.estimated', estimated);

      if (config.perRequest != null && estimated > config.perRequest) {
        return {
          continue: false,
          response: errorResponse(
            'cost_limit_per_request',
            'Request exceeds per-request cost cap',
            { limit: config.perRequest, estimated, status: 429 },
          ),
        };
      }

      if (config.perDay != null) {
        const today = await getSpend(ctx, prefix, dayKey());
        if (today + estimated > config.perDay) {
          return {
            continue: false,
            response: errorResponse('cost_limit_per_day', 'Daily cost cap exceeded', {
              limit: config.perDay,
              spent: today,
              estimated,
              resets_at: nextMidnightUTC(),
              status: 429,
            }),
          };
        }
      }

      if (config.perMonth != null) {
        const month = await getSpend(ctx, prefix, monthKey());
        if (month + estimated > config.perMonth) {
          return {
            continue: false,
            response: errorResponse('cost_limit_per_month', 'Monthly cost cap exceeded', {
              limit: config.perMonth,
              spent: month,
              estimated,
              status: 429,
            }),
          };
        }
      }

      return { continue: true };
    },

    async post(ctx) {
      if (ctx.response.stopReason === 'error') return;
      const actual = calculateActualCost(ctx.request, ctx.response);
      ctx.metadata.set('cost.actual', actual);
      if (actual <= 0) return;

      if (config.perDay != null) {
        await incrementSpend(ctx, prefix, dayKey(), actual);
      }
      if (config.perMonth != null) {
        await incrementSpend(ctx, prefix, monthKey(), actual);
      }
    },
  };
}

function dayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function monthKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

async function getSpend(
  ctx: RequestContext | ResponseContext,
  prefix: string,
  bucket: string,
): Promise<number> {
  const key = spendKey(prefix, ctx.apiKey.userId, bucket);
  const raw = await safeGet(ctx.storage, key);
  if (!raw) return 0;
  const v = Number.parseFloat(raw);
  return Number.isFinite(v) ? v : 0;
}

async function incrementSpend(
  ctx: ResponseContext,
  prefix: string,
  bucket: string,
  delta: number,
): Promise<void> {
  const key = spendKey(prefix, ctx.apiKey.userId, bucket);
  const current = await getSpend(ctx, prefix, bucket);
  // Window TTL: a day bucket lives 48h, a month bucket lives 35 days.
  const ttl = bucket.length === 10 ? 60 * 60 * 48 : 60 * 60 * 24 * 35;
  await ctx.storage.kv.set(key, (current + delta).toString(), ttl);
}

function spendKey(prefix: string, userId: string, bucket: string): string {
  return `${prefix}:spend:${userId}:${bucket}`;
}

async function safeGet(storage: StorageAdapter, key: string): Promise<string | null> {
  try {
    return await storage.kv.get(key);
  } catch {
    return null;
  }
}

function nextMidnightUTC(): string {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return next.toISOString();
}
