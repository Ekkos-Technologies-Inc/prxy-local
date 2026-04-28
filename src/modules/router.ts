/**
 * router — pick the best model for each request.
 *
 * v1 ships three strategies; the smartening lands in v1.1+ without API change:
 *   - 'cheapest-first' (default) — sort `fallback_chain` by est. cost asc, pick cheapest
 *     that fits `budget_per_request`. If `prefer` is set, those are tried first.
 *   - 'fallback' — try `fallback_chain[0]`. (Real fallback-on-error happens at
 *     the gateway pipeline level, not here.)
 *   - 'q-learning' — uses a simple per-(query-bucket, model) success table in KV.
 *     Picks the model with the highest historical success rate for the query
 *     bucket, falling back to cheapest-first when no signal exists. The post
 *     hook updates the success counter from the response outcome.
 *
 * Routing decisions can override `request.model`. The originally-requested
 * model is preserved on `metadata['router.requested_model']`.
 */

import type { Module, RequestContext, ResponseContext } from '../types/sdk.js';

import { estimateRequestCost, getPricing } from '../lib/cost.js';
import { findLastUserMessage } from '../lib/messages.js';

export type RouterStrategy = 'q-learning' | 'fallback' | 'cheapest-first';

export interface RouterConfig {
  strategy?: RouterStrategy;
  fallback_chain?: string[];
  prefer?: string[];
  budget_per_request?: number;
  keyPrefix?: string;
}

interface QStat {
  n: number;
  s: number;
}

export function router(config: RouterConfig = {}): Module {
  const strategy: RouterStrategy = config.strategy ?? 'cheapest-first';
  const chain = config.fallback_chain ?? [];
  const prefer = config.prefer ?? [];
  const budget = config.budget_per_request;
  const prefix = config.keyPrefix ?? 'router';

  return {
    name: 'router',
    version: '1.0.0',

    async pre(ctx) {
      const requested = ctx.request.model;
      ctx.metadata.set('router.requested_model', requested);
      ctx.metadata.set('router.strategy', strategy);

      if (chain.length === 0 && prefer.length === 0) {
        ctx.metadata.set('router.selected_model', requested);
        return { continue: true };
      }

      const seen = new Set<string>();
      const candidates: string[] = [];
      for (const m of [...prefer, ...chain]) {
        if (!seen.has(m)) {
          seen.add(m);
          candidates.push(m);
        }
      }
      if (!seen.has(requested)) candidates.push(requested);

      const affordable =
        budget != null
          ? candidates.filter((m) => estimateForModel(ctx, m) <= budget)
          : candidates;

      if (affordable.length === 0) {
        ctx.metadata.set('router.selected_model', requested);
        return { continue: true };
      }

      let selected: string;
      if (strategy === 'fallback') {
        selected = affordable[0];
      } else if (strategy === 'cheapest-first') {
        selected = pickCheapest(affordable);
      } else {
        selected = await pickByQ(ctx, prefix, affordable);
      }

      ctx.metadata.set('router.selected_model', selected);
      ctx.request.model = selected;

      return { continue: true };
    },

    async post(ctx) {
      if (strategy !== 'q-learning') return;
      const selected = ctx.metadata.get('router.selected_model') as string | undefined;
      if (!selected) return;
      const bucket = bucketFor(ctx);
      const success = ctx.response.stopReason !== 'error' ? 1 : 0;
      try {
        await updateQ(ctx, prefix, bucket, selected, success);
      } catch {
        // Best-effort
      }
    },
  };
}

function estimateForModel(ctx: RequestContext, model: string): number {
  const original = ctx.request.model;
  ctx.request.model = model;
  const cost = estimateRequestCost(ctx.request);
  ctx.request.model = original;
  return cost;
}

function pickCheapest(candidates: string[]): string {
  let best = candidates[0];
  let bestCost = Number.POSITIVE_INFINITY;
  for (const m of candidates) {
    const p = getPricing(m);
    const score = p.input + p.output;
    if (score < bestCost) {
      bestCost = score;
      best = m;
    }
  }
  return best;
}

async function pickByQ(
  ctx: RequestContext,
  prefix: string,
  candidates: string[],
): Promise<string> {
  const bucket = bucketFor(ctx);
  let bestModel = candidates[0];
  let bestRate = -1;
  let sawAnyData = false;
  for (const m of candidates) {
    const stat = await readQ(ctx, prefix, bucket, m);
    if (stat.n === 0) continue;
    sawAnyData = true;
    const rate = stat.s / stat.n;
    if (rate > bestRate) {
      bestRate = rate;
      bestModel = m;
    }
  }
  if (!sawAnyData) return pickCheapest(candidates);
  return bestModel;
}

function bucketFor(ctx: RequestContext | ResponseContext): string {
  const q = findLastUserMessage(ctx.request.messages).toLowerCase().trim();
  if (!q) return 'empty';
  const words = q.split(/\s+/).slice(0, 3).join('-');
  return words.replace(/[^a-z0-9-]/g, '').slice(0, 64) || 'default';
}

async function readQ(
  ctx: RequestContext,
  prefix: string,
  bucket: string,
  model: string,
): Promise<QStat> {
  const key = qKey(prefix, bucket, model);
  try {
    const raw = await ctx.storage.kv.get(key);
    if (!raw) return { n: 0, s: 0 };
    const parsed = JSON.parse(raw);
    if (typeof parsed?.n === 'number' && typeof parsed?.s === 'number') return parsed as QStat;
  } catch {
    // ignore
  }
  return { n: 0, s: 0 };
}

async function updateQ(
  ctx: ResponseContext,
  prefix: string,
  bucket: string,
  model: string,
  success: 0 | 1,
): Promise<void> {
  const key = qKey(prefix, bucket, model);
  const current = await readQ(ctx, prefix, bucket, model);
  const next: QStat = { n: current.n + 1, s: current.s + success };
  await ctx.storage.kv.set(key, JSON.stringify(next), 60 * 60 * 24 * 30);
}

function qKey(prefix: string, bucket: string, model: string): string {
  return `${prefix}:q:${bucket}:${model}`;
}
