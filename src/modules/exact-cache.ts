/**
 * exact-cache — identical canonical request returns cached response.
 *
 * Hash key is sha256 of a stable serialization (sorted keys, no `stream`).
 * Cached responses are stored in KV with a TTL.
 */

import { sha256 } from '../lib/embed.js';
import { serializeRequestStable } from '../lib/messages.js';
import type { CanonicalResponse } from '../types/canonical.js';
import type { Module } from '../types/sdk.js';

export interface ExactCacheConfig {
  /** Cache lifetime in seconds. Default 1 hour. */
  ttlSeconds?: number;
  /** KV key prefix. Default 'exact'. */
  keyPrefix?: string;
}

export function exactCache(config: ExactCacheConfig = {}): Module {
  const ttl = config.ttlSeconds ?? 3600;
  const prefix = config.keyPrefix ?? 'exact';

  return {
    name: 'exact-cache',
    version: '1.0.0',

    async pre(ctx) {
      const hash = sha256(serializeRequestStable(ctx.request));
      const key = `${prefix}:${hash}`;

      const cached = await ctx.storage.kv.get(key);
      if (cached) {
        try {
          const response = JSON.parse(cached) as CanonicalResponse;
          ctx.logger.info(`exact-cache HIT ${hash.slice(0, 12)}`);
          ctx.metadata.set('cache.exact.hit', true);
          ctx.metadata.set('cache.exact.key', key);
          return { continue: false, response };
        } catch {
          // Malformed cache entry — drop it and continue to provider.
          await ctx.storage.kv.del(key);
        }
      }

      ctx.metadata.set('cache.exact.hit', false);
      ctx.metadata.set('cache.exact.key', key);
      return { continue: true };
    },

    async post(ctx) {
      if (ctx.metadata.get('cache.exact.hit')) return;
      const key = ctx.metadata.get('cache.exact.key') as string | undefined;
      if (!key) return;
      // Don't cache error responses.
      if (ctx.response.stopReason === 'error') return;
      await ctx.storage.kv.set(key, JSON.stringify(ctx.response), ttl);
    },
  };
}
