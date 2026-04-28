/**
 * tool-cache — observe and (eventually) cache MCP tool call results.
 *
 * v1 (this module) is intentionally limited:
 *   - POST hook scans the conversation for `tool_use → tool_result` adjacency
 *     pairs and records each `(tool_name, sha256(input))` → `result` mapping
 *     in storage.kv with a TTL.
 *   - PRE hook scans the request for assistant `tool_use` blocks whose
 *     params hash matches a stored entry; if found, it stamps observability
 *     metadata: `tool-cache.would_hit_count`. It does NOT yet rewrite the
 *     request to inject cached results — that needs deeper IPC work because
 *     Anthropic strictly requires every `tool_use` to be answered by a
 *     `tool_result` from the client, not synthesized server-side.
 *
 * v2 will: rewrite the request mid-flight to inject cached results in place
 * of the `tool_use`, breaking the loop earlier and saving the round trip.
 *
 * Excluded tools (default + user-configurable) are NEVER recorded — those are
 * side-effecting and a stale cache would be actively harmful.
 */

import { createHash } from 'node:crypto';

import type { Module } from '../types/sdk.js';
import type { CanonicalMessage, ContentBlock } from '../types/canonical.js';

export interface ToolCacheConfig {
  ttlSeconds?: number;
  excludeTools?: string[];
  perToolTtl?: Record<string, number>;
  keyPrefix?: string;
}

const DEFAULT_EXCLUDED = new Set([
  'bash',
  'shell_exec',
  'shell',
  'send_email',
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'commit',
  'push',
  'deploy',
  'execute_sql',
  'http_request',
]);

export function toolCache(config: ToolCacheConfig = {}): Module {
  const ttl = config.ttlSeconds ?? 60;
  const prefix = config.keyPrefix ?? 'tool-cache';
  const perTool = config.perToolTtl ?? {};
  const excluded = new Set([...DEFAULT_EXCLUDED, ...(config.excludeTools ?? [])]);

  return {
    name: 'tool-cache',
    version: '1.0.0',

    async pre(ctx) {
      const recentCalls = collectRecentToolUses(ctx.request.messages);
      let wouldHit = 0;
      const hitDetails: Array<{ tool: string; key: string }> = [];

      for (const call of recentCalls) {
        if (excluded.has(call.name)) continue;
        const key = cacheKey(prefix, call.name, call.input);
        const cached = await safeGet(ctx.storage.kv, key);
        if (cached !== null) {
          wouldHit++;
          hitDetails.push({ tool: call.name, key });
        }
      }

      ctx.metadata.set('tool-cache.would_hit_count', wouldHit);
      ctx.metadata.set('tool-cache.observed_calls', recentCalls.length);
      if (hitDetails.length > 0) {
        ctx.metadata.set('tool-cache.would_hit_details', hitDetails);
      }

      return { continue: true };
    },

    async post(ctx) {
      const pairs = extractToolUseResultPairs(ctx.request.messages);
      let recorded = 0;

      for (const { name, input, result, isError } of pairs) {
        if (excluded.has(name)) continue;
        if (isError) continue;
        const key = cacheKey(prefix, name, input);
        const itemTtl = perTool[name] ?? ttl;
        try {
          await ctx.storage.kv.set(
            key,
            JSON.stringify({ result, recordedAt: Date.now() }),
            itemTtl,
          );
          recorded++;
        } catch {
          // ignore
        }
      }

      ctx.metadata.set('tool-cache.recorded_count', recorded);
    },
  };
}

interface ObservedToolUse {
  name: string;
  input: unknown;
}

function collectRecentToolUses(messages: CanonicalMessage[]): ObservedToolUse[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') return [];
    return m.content
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({ name: b.name, input: b.input }));
  }
  return [];
}

interface ToolPair {
  name: string;
  input: unknown;
  result: string | ContentBlock[];
  isError: boolean;
}

function extractToolUseResultPairs(messages: CanonicalMessage[]): ToolPair[] {
  const useById = new Map<string, { name: string; input: unknown }>();
  const pairs: ToolPair[] = [];

  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          useById.set(b.id, { name: b.name, input: b.input });
        }
      }
    }
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          const use = useById.get(b.toolUseId);
          if (use) {
            pairs.push({
              name: use.name,
              input: use.input,
              result: b.content,
              isError: b.isError === true,
            });
          }
        }
      }
    }
  }
  return pairs;
}

function cacheKey(prefix: string, name: string, input: unknown): string {
  const stable = JSON.stringify(input ?? {}, sortedReplacer);
  const hash = createHash('sha256').update(stable).digest('hex');
  return `${prefix}:${name}:${hash}`;
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = (value as Record<string, unknown>)[k];
    return out;
  }
  return value;
}

async function safeGet(
  kv: { get(k: string): Promise<string | null> },
  key: string,
): Promise<string | null> {
  try {
    return await kv.get(key);
  } catch {
    return null;
  }
}
