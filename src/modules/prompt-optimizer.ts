/**
 * prompt-optimizer — restructure the request to maximize Anthropic prompt
 * cache hits.
 *
 * Anthropic's prefix cache rewards STABLE prefixes: identical leading bytes
 * across requests stay cached for ~5 minutes. The cheapest input tokens are
 * the ones never re-billed.
 *
 * v1 strategy:
 *   1. Sort `tools` deterministically (alphabetical by name) so two identical
 *      tool sets always serialize the same way at the cache prefix.
 *   2. Stamp `cache_control: { type: 'ephemeral' }` on the LAST system block —
 *      Anthropic caches up to AND including a marker, so the tail of the
 *      static prefix gives you the maximal cacheable region.
 *   3. Optionally also mark the LAST stable assistant turn for mid-conversation
 *      cache reuse.
 *
 * For non-Anthropic providers this is a no-op (the markers ride on the
 * canonical SystemBlock — providers that don't recognize them just ignore).
 */

import type { Module } from '../types/sdk.js';
import type { CanonicalTool, SystemBlock } from '../types/canonical.js';

export type CacheControlMode = 'auto' | 'manual' | 'off';

export interface PromptOptimizerConfig {
  cacheControl?: CacheControlMode;
  separateStatic?: boolean;
  minCacheableChars?: number;
  markAssistantHistory?: boolean;
}

export function promptOptimizer(config: PromptOptimizerConfig = {}): Module {
  const mode: CacheControlMode = config.cacheControl ?? 'auto';
  const separateStatic = config.separateStatic ?? true;
  const minChars = config.minCacheableChars ?? 1024;
  const markAssistant = config.markAssistantHistory ?? false;

  return {
    name: 'prompt-optimizer',
    version: '1.0.0',

    async pre(ctx) {
      ctx.metadata.set('prompt-optimizer.mode', mode);

      if (mode === 'off') {
        ctx.metadata.set('prompt-optimizer.applied', false);
        return { continue: true };
      }

      let mutated = false;

      if (separateStatic && ctx.request.tools && ctx.request.tools.length > 1) {
        const sorted = stableSortTools(ctx.request.tools);
        if (!sameOrder(sorted, ctx.request.tools)) {
          ctx.request.tools = sorted;
          mutated = true;
        }
      }

      if (mode === 'auto') {
        if (ctx.request.system) {
          const total = systemTotalChars(ctx.request.system);
          if (total >= minChars) {
            ctx.request.system = applyCacheMarkerToLastSystemBlock(ctx.request.system);
            mutated = true;
          }
        }

        if (markAssistant) {
          const lastAssistantIdx = lastIndexWhere(
            ctx.request.messages,
            (m) => m.role === 'assistant',
          );
          if (lastAssistantIdx >= 0) {
            ctx.metadata.set('prompt-optimizer.assistant_breakpoint_index', lastAssistantIdx);
            mutated = true;
          }
        }
      }

      ctx.metadata.set('prompt-optimizer.applied', mutated);
      return { continue: true };
    },
  };
}

function stableSortTools(tools: CanonicalTool[]): CanonicalTool[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sameOrder(a: CanonicalTool[], b: CanonicalTool[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name) return false;
  }
  return true;
}

function systemTotalChars(system: string | SystemBlock[]): number {
  if (typeof system === 'string') return system.length;
  return system.reduce((sum, b) => sum + b.text.length, 0);
}

function applyCacheMarkerToLastSystemBlock(
  system: string | SystemBlock[],
): string | SystemBlock[] {
  if (typeof system === 'string') {
    return [{ type: 'text', text: system, cacheControl: { type: 'ephemeral' } }];
  }
  if (system.length === 0) return system;
  return system.map((b, i) => {
    if (i === system.length - 1) {
      return { ...b, cacheControl: { type: 'ephemeral' as const } };
    }
    return b;
  });
}

function lastIndexWhere<T>(arr: T[], pred: (x: T, i: number) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i], i)) return i;
  }
  return -1;
}
